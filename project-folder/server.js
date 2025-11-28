const http = require('http');
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const { randomBytes } = require('crypto');

const app = express();
const server = http.createServer(app);

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Port setup for Codespaces/Heroku/Local
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ server });

let games = {};
let matchmakingQueue = [];

// --- Game Constants ---
const SERVER_TICK_RATE = 60; // 60 updates per second for smoothness
const STATE_HISTORY_LENGTH = 120;
const POINTS_TO_WIN = 11;
const POINTS_TO_CHANGE_SERVE = 2;
const TABLE_WIDTH = 420;
const TABLE_HEIGHT = 750;
const PADDLE_HEIGHT = 22;
const PADDLE_WIDTH = TABLE_WIDTH * 0.25;
const BALL_SIZE = 22;
const RECONNECT_TIMEOUT = 30000; // 30 seconds

wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true); // Heartbeat check

    ws.gameId = null;
    ws.playerNum = null;
    ws.lastProcessedInput = 0;

    ws.on('message', message => {
        try {
            const data = JSON.parse(message.toString());
            const { type, payload } = data;
            const game = games[ws.gameId];

            switch (type) {
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong', payload: { time: payload.time } }));
                    break;
                case 'findMatch':
                    handleFindMatch(ws, payload);
                    break;
                case 'create':
                    handleCreateGame(ws, payload);
                    break;
                case 'join':
                    handleJoinGame(ws, payload);
                    break;
                case 'reconnect':
                    handleReconnect(ws, payload);
                    break;
                case 'input':
                    if (game && payload.seq > ws.lastProcessedInput) {
                        game.inputQueue.push({ playerNum: ws.playerNum, input: payload.data });
                        ws.lastProcessedInput = payload.seq;
                    }
                    break;
                case 'serveBall':
                    if (game && game.state.isWaitingToServe && ws.playerNum === game.state.servingPlayer) {
                        game.state.isWaitingToServe = false;
                        game.state.ball.vx = (Math.random() > 0.5 ? 1 : -1) * 4;
                    }
                    break;
            }
        } catch (error) {
            console.error("Msg Error:", error);
        }
    });

    ws.on('close', () => {
        matchmakingQueue = matchmakingQueue.filter(player => player.ws !== ws);

        const game = games[ws.gameId];
        if (game) {
            if (game.status === 'playing' || game.status === 'reconnecting') {
                const player = ws.playerNum === 1 ? game.player1 : game.player2;
                // Pastikan ini adalah socket pemain yang aktif, bukan koneksi hantu
                if (player && player.ws === ws) {
                    player.disconnected = true;
                    game.status = 'reconnecting';

                    const otherPlayer = ws.playerNum === 1 ? game.player2 : game.player1;
                    if (otherPlayer && otherPlayer.ws.readyState === WebSocket.OPEN) {
                        otherPlayer.ws.send(JSON.stringify({ type: 'opponentReconnecting' }));
                    }

                    console.log(`Player ${ws.playerNum} disconnected. Waiting for reconnect...`);
                    
                    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
                    player.reconnectTimer = setTimeout(() => {
                        console.log(`Timeout Player ${ws.playerNum}. Game Over.`);
                        if (otherPlayer && otherPlayer.ws.readyState === WebSocket.OPEN) {
                            otherPlayer.ws.send(JSON.stringify({ type: 'opponentLeft', payload: { message: 'Lawan tidak kembali.' } }));
                        }
                        cleanupGame(ws.gameId);
                    }, RECONNECT_TIMEOUT);
                }
            } else if (game.status === 'waiting') {
                cleanupGame(ws.gameId);
            }
        }
    });
});

function createNewGameState(player1Name, player1Ws) {
    const paddleInitialX = (TABLE_WIDTH - PADDLE_WIDTH) / 2;
    const initialBallY = TABLE_HEIGHT - 40 - PADDLE_HEIGHT - BALL_SIZE - 5;

    return {
        player1: {
            name: player1Name,
            ws: player1Ws,
            reconnectToken: randomBytes(16).toString('hex'),
            disconnected: false,
            reconnectTimer: null
        },
        player2: null,
        status: 'waiting',
        intervalId: null,
        tick: 0,
        inputQueue: [],
        stateHistory: new Array(STATE_HISTORY_LENGTH),
        state: {
            paddles: { p1_x: paddleInitialX, p2_x: paddleInitialX },
            ball: {
                x: paddleInitialX + (PADDLE_WIDTH / 2) - (BALL_SIZE / 2),
                y: initialBallY,
                vx: 0,
                vy: -5,
            },
            scores: { p1: 0, p2: 0 },
            servingPlayer: 1,
            isWaitingToServe: true,
        }
    };
}

function startGameLoop(gameId) {
    const game = games[gameId];
    if (!game) return;

    if (game.intervalId) clearInterval(game.intervalId);

    game.intervalId = setInterval(() => {
        if (game.status === 'reconnecting') return; // Pause logic

        game.tick++;
        processInputs(game);
        advanceGameState(game.state);
        
        if (checkGameOver(game)) return;
        broadcastGameState(game);

    }, 1000 / SERVER_TICK_RATE);
}

function processInputs(game) {
    while (game.inputQueue.length > 0) {
        const move = game.inputQueue.shift();
        const targetX = Math.max(0, Math.min(TABLE_WIDTH - PADDLE_WIDTH, move.input.paddle_x));
        if (move.playerNum === 1) game.state.paddles.p1_x = targetX;
        else if (move.playerNum === 2) game.state.paddles.p2_x = targetX;
    }
}

function advanceGameState(state) {
    if (state.isWaitingToServe) {
        const servingPaddleX = state.servingPlayer === 1 ? state.paddles.p1_x : state.paddles.p2_x;
        state.ball.x = servingPaddleX + (PADDLE_WIDTH / 2) - (BALL_SIZE / 2);
        return;
    }

    state.ball.x += state.ball.vx;
    state.ball.y += state.ball.vy;

    // Wall collisions
    if (state.ball.x <= 0) { state.ball.vx *= -1; state.ball.x = 0; }
    else if (state.ball.x >= TABLE_WIDTH - BALL_SIZE) { state.ball.vx *= -1; state.ball.x = TABLE_WIDTH - BALL_SIZE; }

    // Paddle collisions
    const { ball, paddles } = state;
    // Player 1 (Bottom)
    if (ball.vy > 0 && ball.y >= TABLE_HEIGHT - 40 - PADDLE_HEIGHT - BALL_SIZE && ball.y <= TABLE_HEIGHT - 40 - PADDLE_HEIGHT) {
        if (ball.x + BALL_SIZE >= paddles.p1_x && ball.x <= paddles.p1_x + PADDLE_WIDTH) {
            ball.vy *= -1.05; // Sedikit akselerasi
            let deltaX = ball.x - (paddles.p1_x + PADDLE_WIDTH / 2);
            ball.vx = deltaX * 0.25;
            // Prevent ball stuck
            ball.y = TABLE_HEIGHT - 40 - PADDLE_HEIGHT - BALL_SIZE - 1;
        }
    }
    // Player 2 (Top)
    if (ball.vy < 0 && ball.y <= 40 + PADDLE_HEIGHT && ball.y >= 40) {
        if (ball.x + BALL_SIZE >= paddles.p2_x && ball.x <= paddles.p2_x + PADDLE_WIDTH) {
            ball.vy *= -1.05;
            let deltaX = ball.x - (paddles.p2_x + PADDLE_WIDTH / 2);
            ball.vx = deltaX * 0.25;
            ball.y = 40 + PADDLE_HEIGHT + 1;
        }
    }

    // Scoring
    if (ball.y < -BALL_SIZE) { updateScore(state, 1); resetBall(state); }
    else if (ball.y > TABLE_HEIGHT) { updateScore(state, 2); resetBall(state); }
}

function updateScore(state, scoringPlayerNum) {
    if (scoringPlayerNum === 1) state.scores.p1++; else state.scores.p2++;
    const { p1, p2 } = state.scores;
    const totalPoints = p1 + p2;
    const isDeuce = p1 >= (POINTS_TO_WIN - 1) && p2 >= (POINTS_TO_WIN - 1);
    
    if (isDeuce) {
        // Change serve every point on deuce
        state.servingPlayer = state.servingPlayer === 1 ? 2 : 1;
    } else {
        if (totalPoints % POINTS_TO_CHANGE_SERVE === 0) {
            state.servingPlayer = state.servingPlayer === 1 ? 2 : 1;
        }
    }
}

function resetBall(state) {
    state.isWaitingToServe = true;
    state.ball.vx = 0;
    if (state.servingPlayer === 1) {
        state.ball.x = state.paddles.p1_x + (PADDLE_WIDTH / 2) - (BALL_SIZE / 2);
        state.ball.y = TABLE_HEIGHT - 40 - PADDLE_HEIGHT - BALL_SIZE - 5;
        state.ball.vy = -5;
    } else {
        state.ball.x = state.paddles.p2_x + (PADDLE_WIDTH / 2) - (BALL_SIZE / 2);
        state.ball.y = 40 + PADDLE_HEIGHT + 5;
        state.ball.vy = 5;
    }
}

function checkGameOver(game) {
    const { p1, p2 } = game.state.scores;
    if ((p1 >= POINTS_TO_WIN || p2 >= POINTS_TO_WIN) && Math.abs(p1 - p2) >= 2) {
        const winnerName = (p1 > p2) ? game.player1.name : game.player2.name;
        const msg = JSON.stringify({ type: 'gameOver', payload: { winnerName } });
        
        safeSend(game.player1, msg);
        safeSend(game.player2, msg);
        
        setTimeout(() => cleanupGame(game.player1.ws.gameId), 2000);
        return true;
    }
    return false;
}

function broadcastGameState(game) {
    const { tick, state } = game;
    // Binary Packing: Tick(4) + P1x(4) + P2x(4) + Bx(4) + By(4) + Bvx(4) + Bvy(4) + S1(1) + S2(1) + Serve(1) + Wait(1) = 32 bytes
    const buffer = new ArrayBuffer(32);
    const view = new DataView(buffer);
    
    view.setUint32(0, tick, true); // Little Endian matches most browsers
    view.setFloat32(4, state.paddles.p1_x, true);
    view.setFloat32(8, state.paddles.p2_x, true);
    view.setFloat32(12, state.ball.x, true);
    view.setFloat32(16, state.ball.y, true);
    view.setFloat32(20, state.ball.vx, true);
    view.setFloat32(24, state.ball.vy, true);
    view.setUint8(28, state.scores.p1);
    view.setUint8(29, state.scores.p2);
    view.setUint8(30, state.servingPlayer);
    view.setUint8(31, state.isWaitingToServe ? 1 : 0);

    if (game.player1 && !game.player1.disconnected && game.player1.ws.readyState === WebSocket.OPEN) game.player1.ws.send(buffer);
    if (game.player2 && !game.player2.disconnected && game.player2.ws.readyState === WebSocket.OPEN) game.player2.ws.send(buffer);
}

function handleFindMatch(ws, payload) {
    const playerA = { playerName: payload.playerName, ws: ws };
    
    // Clean queue of dead connections
    matchmakingQueue = matchmakingQueue.filter(p => p.ws.readyState === WebSocket.OPEN);

    if (matchmakingQueue.length > 0) {
        const playerB = matchmakingQueue.shift();
        const gameId = generateGameId();
        const game = createNewGameState(playerA.playerName, playerA.ws);
        
        game.player2 = { name: playerB.playerName, ws: playerB.ws, reconnectToken: randomBytes(16).toString('hex'), disconnected: false, reconnectTimer: null };
        game.status = 'playing';
        games[gameId] = game;
        
        playerA.ws.gameId = gameId; playerA.ws.playerNum = 1;
        playerB.ws.gameId = gameId; playerB.ws.playerNum = 2;
        
        playerA.ws.send(JSON.stringify({ type: 'gameStarted', payload: { gameId, p1_name: game.player1.name, p2_name: game.player2.name, reconnectToken: game.player1.reconnectToken } }));
        playerB.ws.send(JSON.stringify({ type: 'gameStarted', payload: { gameId, p1_name: game.player1.name, p2_name: game.player2.name, reconnectToken: game.player2.reconnectToken } }));
        
        startGameLoop(gameId);
    } else {
        matchmakingQueue.push(playerA);
        ws.send(JSON.stringify({ type: 'waitingForMatch' }));
    }
}

function handleCreateGame(ws, payload) {
    const gameId = generateGameId();
    ws.gameId = gameId; ws.playerNum = 1;
    games[gameId] = createNewGameState(payload.playerName, ws);
    ws.send(JSON.stringify({ type: 'gameCreated', payload: { gameId } }));
}

function handleJoinGame(ws, payload) {
    const gameId = payload.gameId.toUpperCase();
    const game = games[gameId];
    if (game && game.status === 'waiting') {
        ws.gameId = gameId; ws.playerNum = 2;
        game.player2 = { name: payload.playerName, ws: ws, reconnectToken: randomBytes(16).toString('hex'), disconnected: false, reconnectTimer: null };
        game.status = 'playing';
        
        game.player1.ws.send(JSON.stringify({ type: 'gameStarted', payload: { gameId, p1_name: game.player1.name, p2_name: game.player2.name, reconnectToken: game.player1.reconnectToken } }));
        ws.send(JSON.stringify({ type: 'gameStarted', payload: { gameId, p1_name: game.player1.name, p2_name: game.player2.name, reconnectToken: game.player2.reconnectToken } }));
        
        startGameLoop(gameId);
    } else {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Game tidak ditemukan.' } }));
    }
}

function handleReconnect(ws, payload) {
    const { gameId, reconnectToken } = payload;
    const game = games[gameId];
    
    if (!game) {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Game kadaluarsa.', isReconnectError: true } }));
        return;
    }

    let player, playerNum;
    if (game.player1 && game.player1.reconnectToken === reconnectToken) {
        player = game.player1; playerNum = 1;
    } else if (game.player2 && game.player2.reconnectToken === reconnectToken) {
        player = game.player2; playerNum = 2;
    } else {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Token salah.', isReconnectError: true } }));
        return;
    }

    if (!player.disconnected) {
        // Force old connection to close if it's zombie
        try { player.ws.terminate(); } catch(e){}
    }

    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    
    player.ws = ws;
    player.disconnected = false;
    ws.gameId = gameId;
    ws.playerNum = playerNum;

    ws.send(JSON.stringify({ 
        type: 'reconnectSuccess',
        payload: { p1_name: game.player1.name, p2_name: game.player2.name, playerNum: playerNum }
    }));
    
    if (!game.player1.disconnected && (!game.player2 || !game.player2.disconnected)) {
        game.status = 'playing';
        const resumeMsg = JSON.stringify({ type: 'gameResumed' });
        safeSend(game.player1, resumeMsg);
        safeSend(game.player2, resumeMsg);
    }
}

function safeSend(player, msg) {
    if (player && !player.disconnected && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(msg);
    }
}

function cleanupGame(gameId) {
    if (games[gameId]) {
        clearInterval(games[gameId].intervalId);
        delete games[gameId];
        console.log(`Game ${gameId} cleaned up.`);
    }
}

function generateGameId() { return Math.random().toString(36).substring(2, 7).toUpperCase(); }

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
