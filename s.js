const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8005;

const UPDATE_RATE = 240;
const BATCH_INTERVAL = 1000 / UPDATE_RATE;
const MAX_CHAT_HISTORY = 25;
const HEARTBEAT_INTERVAL = 5000;
const POSITION_THRESHOLD = 0.001;
const ROTATION_THRESHOLD = 0.001;

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/roadblocks.html') {
        const filePath = path.join(__dirname, 'roadblocks.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading roadblocks.html');
                console.error('Error serving roadblocks.html:', err);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: {
        zlibDeflateOptions: {
            threshold: 1024,
            concurrencyLimit: 10,
        },
    }
});

const clients = new Map();
const chatHistory = [];
const pendingUpdates = new Map();
let updateBatchTimer = null;

function generateUniqueId() {
    return Math.random().toString(36).substr(2, 6);
}

function batchBroadcast(message, excludeWs = null, priority = false) {
    if (priority) {
        broadcastImmediate(message, excludeWs);
        return;
    }

    clients.forEach((clientData, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            if (!pendingUpdates.has(ws)) {
                pendingUpdates.set(ws, []);
            }
            pendingUpdates.get(ws).push(message);
        }
    });

    if (!updateBatchTimer) {
        updateBatchTimer = setTimeout(flushBatchedUpdates, BATCH_INTERVAL);
    }
}

function broadcastImmediate(message, excludeWs = null) {
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    clients.forEach((clientData, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(messageStr);
            } catch (e) {
                console.error('Error broadcasting message to client:', clientData.id, e);
                handleClientDisconnect(ws);
            }
        }
    });
}

function flushBatchedUpdates() {
    pendingUpdates.forEach((messages, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                if (messages.length === 1) {
                    ws.send(typeof messages[0] === 'string' ? messages[0] : JSON.stringify(messages[0]));
                } else if (messages.length > 1) {
                    ws.send(JSON.stringify({ type: 'batch_update', updates: messages }));
                }
            } catch (e) {
                console.error('Error sending batched updates:', e);
                handleClientDisconnect(ws);
            }
        }
    });
    
    pendingUpdates.clear();
    updateBatchTimer = null;
}

function hasSignificantChange(oldState, newState) {
    if (!oldState) return true;
    
    const posChanged = Math.abs(oldState.position.x - newState.position.x) > POSITION_THRESHOLD ||
                      Math.abs(oldState.position.y - newState.position.y) > POSITION_THRESHOLD ||
                      Math.abs(oldState.position.z - newState.position.z) > POSITION_THRESHOLD;
    
    const rotChanged = Math.abs(oldState.rotationY - newState.rotationY) > ROTATION_THRESHOLD;
    
    const stateChanged = oldState.isMoving !== newState.isMoving ||
                        oldState.isGrounded !== newState.isGrounded;
    
    return posChanged || rotChanged || stateChanged;
}

function handleClientDisconnect(ws) {
    const clientData = clients.get(ws);
    if (clientData) {
        clients.delete(ws);
        pendingUpdates.delete(ws);
        console.log(`Client ${clientData.id} disconnected.`);
        broadcastImmediate(JSON.stringify({ type: 'player_left', id: clientData.id }));
    }
}

function heartbeat() {
    this.isAlive = true;
}

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            handleClientDisconnect(ws);
            return ws.terminate();
        }
        
        ws.isAlive = false;
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    });
}, HEARTBEAT_INTERVAL);

wss.on('connection', (ws) => {
    const clientId = generateUniqueId();
    const initialState = {
        position: { x: 0, y: 0, z: 0 },
        rotationY: 0,
        isMoving: false,
        isGrounded: true,
        velocityY: 0,
        velocity: { x: 0, y: 0, z: 0 },
        timestamp: Date.now()
    };
    
    clients.set(ws, { 
        id: clientId, 
        state: initialState,
        lastUpdate: Date.now(),
        lastHeartbeat: Date.now()
    });

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    console.log(`Client ${clientId} connected. Total clients: ${clients.size}`);

    ws.send(JSON.stringify({ 
        type: 'assign_id', 
        id: clientId, 
        initialState: initialState,
        serverTime: Date.now()
    }));

    const existingPlayersData = [];
    clients.forEach((clientData, clientWs) => {
        if (clientWs !== ws) {
            existingPlayersData.push({ id: clientData.id, state: clientData.state });
        }
    });
    
    if (existingPlayersData.length > 0) {
        ws.send(JSON.stringify({ type: 'existing_players', playersData: existingPlayersData }));
    }

    if (chatHistory.length > 0) {
        ws.send(JSON.stringify({ type: 'chat_history', history: chatHistory }));
    }

    broadcastImmediate(JSON.stringify({
        type: 'player_joined',
        playerData: { id: clientId, state: initialState }
    }), ws);

    ws.on('message', (messageString) => {
        try {
            const message = JSON.parse(messageString);
            const senderData = clients.get(ws);
            const now = Date.now();

            if (!senderData) return;

            senderData.lastHeartbeat = now;

            if (message.type === 'player_update') {
                if (hasSignificantChange(senderData.state, message.state)) {
                    message.state.serverTimestamp = now;
                    message.state.clientTimestamp = message.state.timestamp || now;
                    
                    senderData.state = { ...message.state };
                    senderData.lastUpdate = now;

                    batchBroadcast({
                        type: 'player_update',
                        id: senderData.id,
                        state: message.state
                    }, ws, false);
                }
            } else if (message.type === 'chat_message') {
                const chatEntry = {
                    senderId: senderData.id,
                    message: message.message,
                    timestamp: now
                };

                chatHistory.push(chatEntry);

                if (chatHistory.length > MAX_CHAT_HISTORY) {
                    chatHistory.shift();
                }

                broadcastImmediate(JSON.stringify({
                    type: 'chat_message',
                    senderId: senderData.id,
                    message: message.message,
                    timestamp: now
                }));
            } else if (message.type === 'emote_command') {
                const validEmotes = ['wave', 'dance'];
                if (validEmotes.includes(message.emote)) {
                    broadcastImmediate(JSON.stringify({
                        type: 'emote_start',
                        playerId: senderData.id,
                        emote: message.emote,
                        timestamp: now
                    }));
                }
            } else if (message.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    clientTimestamp: message.timestamp,
                    serverTimestamp: now
                }));
            }
        } catch (e) {
            console.error('Failed to process message:', e);
        }
    });

    ws.on('close', () => {
        handleClientDisconnect(ws);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clients.get(ws)?.id || 'unknown'}:`, error);
        handleClientDisconnect(ws);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`High-performance WebSocket server listening on http://0.0.0.0:${PORT}`);
    console.log(`Update rate: ${UPDATE_RATE}fps, Batch interval: ${BATCH_INTERVAL}ms`);
});