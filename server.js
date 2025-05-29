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

const connectedUsers = new Map();
const conversationHistory = [];
const prompts = [];
let clearVoteSession = null;
const typingUsers = new Set();
const MAX_HISTORY = 100;

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
    }
};

const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        connectedUsers.set(socket.id, { id: socket.id, username, joinedAt: new Date() });
        socket.emit('conversation_history', conversationHistory);
        socket.emit('prompts_list', prompts);
        io.emit('user_joined', { username, userCount: connectedUsers.size });
        io.emit('user_count_update', connectedUsers.size);
    });

    socket.on('user_message', async (data) => {
        const user = connectedUsers.get(socket.id);
        if (!user) return;
        const messageData = {
            id: Date.now(),
            type: 'user',
            username: user.username,
            content: data.message,
            timestamp: new Date()
        };
        conversationHistory.push(messageData);
        io.emit('new_message', messageData);

        try {
            io.emit('ai_typing', true);
            const aiResponse = await generateAIResponse(data.message, conversationHistory);
            const aiMessageData = {
                id: Date.now() + 1,
                type: 'ai',
                username: 'AI Assistant',
                content: aiResponse.content,
                tokensUsed: aiResponse.usage.total_tokens,
                timestamp: new Date()
            };
            conversationHistory.push(aiMessageData);
            if (conversationHistory.length > MAX_HISTORY) {
                conversationHistory.shift();
            }
            io.emit('ai_typing', false);
            io.emit('new_message', aiMessageData);
        } catch (error) {
            io.emit('ai_typing', false);
            io.emit('ai_error', 'Sorry, I encountered an error. Please try again.');
        }
    });

    socket.on('typing', () => {
        typingUsers.add(socket.id);
        io.emit('user_typing', typingUsers.size);
    });

    socket.on('stop_typing', () => {
        typingUsers.delete(socket.id);
        io.emit('user_typing', typingUsers.size);
    });

    socket.on('submit_prompt', (text) => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            const prompt = {
                id: Date.now(),
                text,
                submitter: user.username,
                votes: new Set(),
                timestamp: new Date()
            };
            prompts.push(prompt);
            io.emit('new_prompt', prompt);
        }
    });

    socket.on('vote_prompt', (promptId) => {
        const prompt = prompts.find(p => p.id === promptId);
        if (prompt && !prompt.votes.has(socket.id)) {
            prompt.votes.add(socket.id);
            io.emit('prompts_list', prompts); // Update all clients
            if (prompt.votes.size > 0.5 * connectedUsers.size) {
                selectPrompt(prompt);
            }
        }
    });

    socket.on('propose_clear', () => {
        if (!clearVoteSession) {
            clearVoteSession = {
                id: Date.now(),
                yesVotes: new Set(),
                noVotes: new Set(),
                timeout: setTimeout(checkClearVote, 60000)
            };
            io.emit('clear_vote_start');
        }
    });

    socket.on('clear_vote', ({ vote }) => {
        if (clearVoteSession) {
            if (vote === 'yes') {
                clearVoteSession.yesVotes.add(socket.id);
            } else {
                clearVoteSession.noVotes.add(socket.id);
            }
            if (clearVoteSession.yesVotes.size > 0.8 * connectedUsers.size) {
                clearChat();
            } else if (clearVoteSession.noVotes.size >= 0.2 * connectedUsers.size) {
                endClearVote();
            }
        }
    });

    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            connectedUsers.delete(socket.id);
            typingUsers.delete(socket.id);
            prompts.forEach(prompt => prompt.votes.delete(socket.id));
            if (clearVoteSession) {
                clearVoteSession.yesVotes.delete(socket.id);
                clearVoteSession.noVotes.delete(socket.id);
            }
            io.emit('user_left', { username: user.username, userCount: connectedUsers.size });
            io.emit('user_count_update', connectedUsers.size);
            io.emit('user_typing', typingUsers.size);
        }
    });
});

async function generateAIResponse(userMessage, history) {
    const config = AI_CONFIG[AI_PROVIDER];
    const recentHistory = history.slice(-10).map(msg => ({
        role: msg.type === 'user' ? 'user' : 'assistant',
        content: msg.content
    }));
    const messages = [
        { role: 'system', content: 'You are a helpful AI assistant in a multi-user chat room.' },
        ...recentHistory,
        { role: 'user', content: userMessage }
    ];
    const requestBody = {
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: 500
    };
    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });
        return {
            content: response.data.choices[0].message.content,
            usage: response.data.usage
        };
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        return { content: 'Sorry, I encountered an error.', usage: { total_tokens: 0 } };
    }
}

async function selectPrompt(prompt) {
    const systemMessage = {
        id: Date.now(),
        type: 'system',
        username: 'System',
        content: `The prompt "${prompt.text}" was selected.`,
        timestamp: new Date()
    };
    conversationHistory.push(systemMessage);
    io.emit('new_message', systemMessage);

    try {
        io.emit('ai_typing', true);
        const aiResponse = await generateAIResponse(prompt.text, conversationHistory);
        const aiMessageData = {
            id: Date.now() + 1,
            type: 'ai',
            username: 'AI Assistant',
            content: aiResponse.content,
            tokensUsed: aiResponse.usage.total_tokens,
            timestamp: new Date()
        };
        conversationHistory.push(aiMessageData);
        if (conversationHistory.length > MAX_HISTORY) {
            conversationHistory.shift();
        }
        io.emit('ai_typing', false);
        io.emit('new_message', aiMessageData);
        prompts.length = 0;
        io.emit('prompts_list', []);
    } catch (error) {
        io.emit('ai_typing', false);
        io.emit('ai_error', 'Sorry, I encountered an error.');
    }
}

function clearChat() {
    conversationHistory.length = 0;
    io.emit('clear_chat');
    endClearVote();
}

function endClearVote() {
    if (clearVoteSession) {
        clearTimeout(clearVoteSession.timeout);
        clearVoteSession = null;
        io.emit('clear_vote_end');
    }
}

function checkClearVote() {
    if (clearVoteSession && clearVoteSession.yesVotes.size > 0.8 * connectedUsers.size) {
        clearChat();
    } else {
        endClearVote();
    }
}

setInterval(() => {
    if (prompts.length > 0) {
        const maxVotes = Math.max(...prompts.map(p => p.votes.size));
        if (maxVotes > 0) {
            const topPrompt = prompts.find(p => p.votes.size === maxVotes);
            selectPrompt(topPrompt);
        }
    }
}, 60000);

server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER}`);
    console.log(`📝 Visit http://localhost:${PORT} to start chatting`);
});
