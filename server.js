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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store connected users and conversation history
const connectedUsers = new Map();
const conversationHistory = [];
const MAX_HISTORY = 100; // Keep last 100 messages

// AI Configuration
const AI_CONFIG = {
    // For OpenAI ChatGPT
    openai: {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'gpt-3.5-turbo'
    },
    // For xAI Grok (when available)
    xai: {
        url: 'https://api.x.ai/v1/chat/completions',
        headers: {
            'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        model: 'grok-3-latest'
    }
};

// Choose which AI to use (set in environment variable)
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Handle user joining
    socket.on('join', (username) => {
        const userData = {
            id: socket.id,
            username: username,
            joinedAt: new Date()
        };
        
        connectedUsers.set(socket.id, userData);
        
        // Send conversation history to new user
        socket.emit('conversation_history', conversationHistory);
        
        // Notify all users about new user
        io.emit('user_joined', {
            username: username,
            userCount: connectedUsers.size
        });
        
        // Update user count for all clients
        io.emit('user_count_update', connectedUsers.size);
        
        console.log(`${username} joined the chat`);
    });

    // Handle user messages
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

        // Store message in history
        conversationHistory.push(messageData);
        
        // Broadcast user message to all clients
        io.emit('new_message', messageData);

        // Generate AI response
        try {
            // Show typing indicator
            io.emit('ai_typing', true);
            
            const aiResponse = await generateAIResponse(data.message, conversationHistory);
            
            const aiMessageData = {
                id: Date.now() + 1,
                type: 'ai',
                username: 'AI Assistant',
                content: aiResponse,
                timestamp: new Date()
            };

            // Store AI response in history
            conversationHistory.push(aiMessageData);
            
            // Keep history size manageable
            if (conversationHistory.length > MAX_HISTORY) {
                conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY);
            }

            // Hide typing indicator and send AI response
            io.emit('ai_typing', false);
            io.emit('new_message', aiMessageData);

        } catch (error) {
            console.error('AI Response Error:', error);
            io.emit('ai_typing', false);
            io.emit('ai_error', 'Sorry, I encountered an error. Please try again.');
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        const user = connectedUsers.get(socket.id);
        if (user) {
            connectedUsers.delete(socket.id);
            
            // Notify all users about user leaving
            io.emit('user_left', {
                username: user.username,
                userCount: connectedUsers.size
            });
            
            // Update user count
            io.emit('user_count_update', connectedUsers.size);
            
            console.log(`${user.username} left the chat`);
        }
    });
});

// Function to generate AI response
async function generateAIResponse(userMessage, history) {
    const config = AI_CONFIG[AI_PROVIDER];
    
    if (!config) {
        throw new Error(`AI provider ${AI_PROVIDER} not configured`);
    }

    // Prepare conversation context (last 10 messages for context)
    const recentHistory = history.slice(-10).map(msg => ({
        role: msg.type === 'user' ? 'user' : 'assistant',
        content: msg.content
    }));

    // Add system message for context
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful AI assistant in a multi-user chat room. Be friendly, informative, and engaging. Keep responses conversational and not too long.'
        },
        ...recentHistory,
        {
            role: 'user',
            content: userMessage
        }
    ];

    const requestBody = {
        model: config.model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 500
    };

    try {
        const response = await axios.post(config.url, requestBody, {
            headers: config.headers,
            timeout: 30000
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('AI API Error:', error.response?.data || error.message);
        
        // Fallback responses if API fails
        const fallbackResponses = [
            "I'm having trouble connecting to my AI service right now. Please try again in a moment!",
            "Sorry, I'm experiencing some technical difficulties. Let me know if you'd like to try again!",
            "It seems there's an issue with my connection. Please retry your message!"
        ];
        
        return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        connectedUsers: connectedUsers.size,
        uptime: process.uptime(),
        timestamp: new Date()
    });
});

// API endpoint to get current stats
app.get('/api/stats', (req, res) => {
    res.json({
        connectedUsers: connectedUsers.size,
        totalMessages: conversationHistory.length,
        aiProvider: AI_PROVIDER
    });
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🤖 AI Provider: ${AI_PROVIDER}`);
    console.log(`📝 Visit http://localhost:${PORT} to start chatting`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
    });
});
