const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Enhanced data structures
const connectedUsers = new Map();
const conversationHistory = [];
const prompts = [];
let clearVoteSession = null;
const typingUsers = new Set();
const MAX_HISTORY = 150;
const MAX_PROMPTS = 20;

// AI Configuration with fallback
const AI_CONFIG = {
    openai: {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'gpt-3.5-turbo'
    },
    xai: {
        url: 'https://api.x.ai/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'grok-3-latest'
    },
    claude: {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
            'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}`,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01'
        },
        model: 'claude-3-haiku-20240307'
    }
};

const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// Utility functions
function sanitizeMessage(message) {
    return message.trim().substring(0, 2000); // Limit message length
}

function isValidUsername(username) {
    return username && 
           username.trim().length >= 2 && 
           username.trim().length <= 20 && 
           /^[a-zA-Z0-9_\-\s]+$/.test(username.trim());
}

function getUsernameById(socketId) {
    const user = connectedUsers.get(socketId);
    return user ? user.username : 'Unknown User';
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    socket.on('join', (username) => {
        const sanitizedUsername = username.trim();
        
        if (!isValidUsername(sanitizedUsername)) {
            socket.emit('join_error', 'Username must be 2-20 characters and contain only letters, numbers, spaces, hyphens, and underscores.');
            return;
        }

        // Check for duplicate usernames
        const existingUser = Array.from(connectedUsers.values()).find(user => 
            user.username.toLowerCase() === sanitizedUsername.toLowerCase()
        );
        
        if (existingUser) {
            socket.emit('join_error', 'Username already taken. Please choose another.');
            return;
        }

        const userData = {
            id: socket.id,
            username: sanitizedUsername,
            joinedAt: new Date(),
            isActive: true
        };

        connectedUsers.set(socket.id, userData);
        
        // Send initial data
        socket.emit('join_success');
        socket.emit('conversation_history', conversationHistory);
        socket.emit('prompts_list', serializePrompts());
        
        // Notify all users
        const joinMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            username: 'System',
            content: `${sanitizedUsername} joined the chat`,
            timestamp: new Date()
        };
        
        conversationHistory.push(joinMessage);
        io.emit('new_message', joinMessage);
        io.emit('user_joined', { username: sanitizedUsername, userCount: connectedUsers.size });
        io.emit('user_count_update', connectedUsers.size);
        
        console.log(`User ${sanitizedUsername} joined. Total users: ${connectedUsers.size}`);
    });

    socket.on('user_message', async (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !data.message) return;

        const sanitizedMessage = sanitizeMessage(data.message);
        if (!sanitizedMessage) return;

        const messageData = {
            id: `user_${Date.now()}_${socket.id}`,
            type: 'user',
            username: user.username,
            content: sanitizedMessage,
            timestamp: new Date()
        };

        conversationHistory.push(messageData);
        manageHistoryLimit();
        io.emit('new_message', messageData);

        // Generate AI response
        try {
            io.emit('ai_typing', true);
            const aiResponse = await generateAIResponse(sanitizedMessage, conversationHistory);
            
            const aiMessageData = {
                id: `ai_${Date.now()}`,
                type: 'ai',
                username: 'AI Assistant',
                content: aiResponse.content,
                tokensUsed: aiResponse.usage?.total_tokens || 0,
                timestamp: new Date()
            };

            conversationHistory.push(aiMessageData);
            manageHistoryLimit();
            
            io.emit('ai_typing', false);
            io.emit('new_message', aiMessageData);
        } catch (error) {
            console.error('AI Response Error:', error);
            io.emit('ai_typing', false);
            io.emit('ai_error', 'Sorry, I encountered an error processing your message. Please try again.');
        }
    });

    socket.on('typing', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            typingUsers.add(socket.id);
            socket.broadcast.emit('user_typing', {
                count: typingUsers.size,
                users: Array.from(typingUsers).map(id => getUsernameById(id)).filter(Boolean)
            });
        }
    });

    socket.on('stop_typing', () => {
        typingUsers.delete(socket.id);
        socket.broadcast.emit('user_typing', {
            count: typingUsers.size,
            users: Array.from(typingUsers).map(id => getUsernameById(id)).filter(Boolean)
        });
    });

    socket.on('submit_prompt', (text) => {
        const user = connectedUsers.get(socket.id);
        if (!user || !text || typeof text !== 'string') return;

        const sanitizedText = text.trim().substring(0, 500);
        if (!sanitizedText) return;

        // Check for duplicate prompts
        const isDuplicate = prompts.some(p => 
            p.text.toLowerCase() === sanitizedText.toLowerCase() ||
            p.submitter === user.username
        );

        if (isDuplicate) {
            socket.emit('prompt_error', 'You already have a pending prompt or this prompt already exists.');
            return;
        }

        const prompt = {
            id: `prompt_${Date.now()}_${socket.id}`,
            text: sanitizedText,
            submitter: user.username,
            submitterId: socket.id,
            votes: new Set(),
            timestamp: new Date()
        };

        prompts.push(prompt);
        managePromptsLimit();
        
        io.emit('new_prompt', serializePrompt(prompt));
        io.emit('prompts_list', serializePrompts());
    });

    socket.on('vote_prompt', (promptId) => {
        const user = connectedUsers.get(socket.id);
        const prompt = prompts.find(p => p.id === promptId);
        
        if (!user || !prompt) {
            socket.emit('vote_error', 'Prompt not found.');
            return;
        }

        if (prompt.submitterId === socket.id) {
            socket.emit('vote_error', 'You cannot vote for your own prompt.');
            return;
        }

        if (prompt.votes.has(socket.id)) {
            socket.emit('vote_error', 'You have already voted for this prompt.');
            return;
        }

        prompt.votes.add(socket.id);
        io.emit('prompts_list', serializePrompts());
        
        // Check if prompt should be selected (majority vote)
        const requiredVotes = Math.max(2, Math.ceil(connectedUsers.size * 0.6));
        if (prompt.votes.size >= requiredVotes) {
            selectPrompt(prompt);
        }
    });

    socket.on('propose_clear', () => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;

        if (clearVoteSession) {
            socket.emit('clear_vote_error', 'A clear vote is already in progress.');
            return;
        }

        if (connectedUsers.size < 2) {
            socket.emit('clear_vote_error', 'Need at least 2 users to propose clearing chat.');
            return;
        }

        startClearVote(user.username);
    });

    socket.on('clear_vote', (vote) => {
        if (!clearVoteSession || (vote !== 'yes' && vote !== 'no')) return;

        const user = connectedUsers.get(socket.id);
        if (!user) return;

        // Remove previous vote if exists
        clearVoteSession.yesVotes.delete(socket.id);
        clearVoteSession.noVotes.delete(socket.id);

        // Add new vote
        if (vote === 'yes') {
            clearVoteSession.yesVotes.add(socket.id);
        } else {
            clearVoteSession.noVotes.add(socket.id);
        }

        const totalVotes = clearVoteSession.yesVotes.size + clearVoteSession.noVotes.size;
        const yesPercentage = clearVoteSession.yesVotes.size / connectedUsers.size;
        const noPercentage = clearVoteSession.noVotes.size / connectedUsers.size;

        // Update vote status
        io.emit('clear_vote_update', {
            yesVotes: clearVoteSession.yesVotes.size,
            noVotes: clearVoteSession.noVotes.size,
            totalUsers: connectedUsers.size,
            hasVoted: new Set([...clearVoteSession.yesVotes, ...clearVoteSession.noVotes])
        });

        // Check for decision
        if (yesPercentage >= 0.7) { // 70% yes votes required
            executeClearChat();
        } else if (noPercentage >= 0.4 || totalVotes === connectedUsers.size) { // 40% no votes or everyone voted
            endClearVote('rejected');
        }
    });

    socket.on('disconnect', () => {
        handleUserDisconnect(socket.id);
    });
});

// Enhanced AI response generation
async function generateAIResponse(userMessage, history) {
    const config = AI_CONFIG[AI_PROVIDER];
    
    if (!config) {
        throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }

    // Build conversation context
    const recentHistory = history
        .filter(msg => msg.type !== 'system')
        .slice(-8)
        .map(msg => ({
            role: msg.type === 'user' ? 'user' : 'assistant',
            content: msg.content
        }));

    if (AI_PROVIDER === 'claude') {
        return await generateClaudeResponse(userMessage, recentHistory, config);
    } else {
        return await generateOpenAIStyleResponse(userMessage, recentHistory, config);
    }
}

async function generateOpenAIStyleResponse(userMessage, recentHistory, config) {
    const messages = [
        { 
            role: 'system', 
            content: 'You are a helpful AI assistant in a multi-user chat room. Be conversational, friendly, and concise. Keep responses under 300 words unless specifically asked for detailed information.' 
        },
        ...recentHistory,
        { role: 'user', content: userMessage }
    ];

    const requestBody = {
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: 400,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
    };

    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });

        return {
            content: response.data.choices[0].message.content.trim(),
            usage: response.data.usage || { total_tokens: 0 }
        };
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        throw error;
    }
}

async function generateClaudeResponse(userMessage, recentHistory, config) {
    const contextMessages = recentHistory.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    const fullPrompt = contextMessages ? `${contextMessages}\nuser: ${userMessage}` : userMessage;

    const requestBody = {
        model: config.model,
        max_tokens: 400,
        messages: [{ role: 'user', content: fullPrompt }],
        system: 'You are a helpful AI assistant in a multi-user chat room. Be conversational, friendly, and concise.'
    };

    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });

        return {
            content: response.data.content[0].text.trim(),
            usage: response.data.usage || { total_tokens: 0 }
        };
    } catch (error) {
        console.error('Claude API Error:', error.response?.data || error.message);
        throw error;
    }
}

// Prompt management
async function selectPrompt(prompt) {
    const systemMessage = {
        id: `system_${Date.now()}`,
        type: 'system',
        username: 'System',
        content: `🗳️ Selected prompt: "${prompt.text}" (${prompt.votes.size} votes)`,
        timestamp: new Date()
    };

    conversationHistory.push(systemMessage);
    io.emit('new_message', systemMessage);

    try {
        io.emit('ai_typing', true);
        const aiResponse = await generateAIResponse(prompt.text, conversationHistory);
        
        const aiMessageData = {
            id: `ai_${Date.now()}`,
            type: 'ai',
            username: 'AI Assistant',
            content: aiResponse.content,
            tokensUsed: aiResponse.usage?.total_tokens || 0,
            timestamp: new Date()
        };

        conversationHistory.push(aiMessageData);
        manageHistoryLimit();
        
        io.emit('ai_typing', false);
        io.emit('new_message', aiMessageData);
        
        // Clear prompts after selection
        prompts.length = 0;
        io.emit('prompts_list', []);
        
    } catch (error) {
        console.error('Error processing selected prompt:', error);
        io.emit('ai_typing', false);
        io.emit('ai_error', 'Sorry, I encountered an error processing the selected prompt.');
    }
}

// Clear chat functionality
function startClearVote(proposerUsername) {
    clearVoteSession = {
        id: Date.now(),
        proposer: proposerUsername,
        yesVotes: new Set(),
        noVotes: new Set(),
        startTime: new Date(),
        timeout: setTimeout(() => endClearVote('timeout'), 60000) // 1 minute timeout
    };

    io.emit('clear_vote_start', {
        proposer: proposerUsername,
        totalUsers: connectedUsers.size,
        timeLimit: 60
    });
}

function executeClearChat() {
    conversationHistory.length = 0;
    prompts.length = 0;
    
    const clearMessage = {
        id: `system_${Date.now()}`,
        type: 'system',
        username: 'System',
        content: '🧹 Chat has been cleared by community vote.',
        timestamp: new Date()
    };
    
    conversationHistory.push(clearMessage);
    
    io.emit('clear_chat');
    io.emit('new_message', clearMessage);
    io.emit('prompts_list', []);
    
    endClearVote('approved');
}

function endClearVote(result = 'timeout') {
    if (clearVoteSession) {
        clearTimeout(clearVoteSession.timeout);
        
        let message = '';
        switch(result) {
            case 'approved':
                message = '✅ Clear chat vote passed.';
                break;
            case 'rejected':
                message = '❌ Clear chat vote failed.';
                break;
            case 'timeout':
                message = '⏰ Clear chat vote timed out.';
                break;
        }
        
        if (message) {
            io.emit('system_notification', message);
        }
        
        clearVoteSession = null;
        io.emit('clear_vote_end');
    }
}

// User disconnect handling
function handleUserDisconnect(socketId) {
    const user = connectedUsers.get(socketId);
    if (user) {
        // Remove user from all collections
        connectedUsers.delete(socketId);
        typingUsers.delete(socketId);
        
        // Remove votes from prompts
        prompts.forEach(prompt => {
            prompt.votes.delete(socketId);
        });
        
        // Remove from clear vote session
        if (clearVoteSession) {
            clearVoteSession.yesVotes.delete(socketId);
            clearVoteSession.noVotes.delete(socketId);
            
            // Check if clear vote should still continue
            if (connectedUsers.size === 0) {
                endClearVote('cancelled');
            }
        }
        
        // Add leave message
        const leaveMessage = {
            id: `system_${Date.now()}`,
            type: 'system',
            username: 'System',
            content: `${user.username} left the chat`,
            timestamp: new Date()
        };
        
        conversationHistory.push(leaveMessage);
        io.emit('new_message', leaveMessage);
        io.emit('user_left', { username: user.username, userCount: connectedUsers.size });
        io.emit('user_count_update', connectedUsers.size);
        io.emit('user_typing', { count: typingUsers.size, users: [] });
        
        console.log(`User ${user.username} disconnected. Total users: ${connectedUsers.size}`);
    }
}

// Utility functions for data management
function manageHistoryLimit() {
    while (conversationHistory.length > MAX_HISTORY) {
        conversationHistory.shift();
    }
}

function managePromptsLimit() {
    while (prompts.length > MAX_PROMPTS) {
        prompts.shift();
    }
}

function serializePrompts() {
    return prompts.map(prompt => serializePrompt(prompt));
}

function serializePrompt(prompt) {
    return {
        id: prompt.id,
        text: prompt.text,
        submitter: prompt.submitter,
        votes: prompt.votes.size,
        timestamp: prompt.timestamp
    };
}

// Periodic cleanup
setInterval(() => {
    // Auto-select most voted prompt if there are prompts older than 5 minutes
    if (prompts.length > 0) {
        const oldPrompts = prompts.filter(p => 
            Date.now() - p.timestamp.getTime() > 300000 // 5 minutes
        );
        
        if (oldPrompts.length > 0) {
            const maxVotes = Math.max(...oldPrompts.map(p => p.votes.size));
            if (maxVotes > 0) {
                const topPrompt = oldPrompts.find(p => p.votes.size === maxVotes);
                selectPrompt(topPrompt);
            }
        }
    }
}, 120000); // Check every 2 minutes

// Server startup
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER}`);
    console.log(`📝 Visit http://localhost:${PORT} to start chatting`);
    
    // Validate AI configuration
    const config = AI_CONFIG[AI_PROVIDER];
    if (!config) {
        console.warn(`⚠️  Unknown AI provider: ${AI_PROVIDER}`);
    } else {
        console.log(`✅ AI configuration loaded for ${AI_PROVIDER}`);
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    server.close(() => {
        console.log('✅ Server shutdown complete');
        process.exit(0);
    });
});
