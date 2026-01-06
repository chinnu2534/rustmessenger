// ==========================
// Global Variables
// ==========================
let socket = null;
let currentUser = null;
let authToken = null;
let currentConversation = null;
let currentGroup = null;
let contacts = [];
let memberGroups = []; // Groups user is a member of
let availableGroups = []; // Groups user can join
let reactionPickerTimeout = null;
// Reactions that arrived before the message DOM exists
const pendingReactions = new Map(); // messageId -> reactions object

// WebRTC state
let pc = null;
let localStream = null;
let remoteStream = null;
let pendingIceCandidates = [];
const offerRequestedFrom = new Set();
let currentCallPeer = null; // username of the peer for the active call
let revealAtISO = null; // ISO datetime for next message reveal
let pendingRevealISO = null; // apply to next own displayed message if server didn't include
let pendingGhostNotice = null; // show a history-style banner after history loads

// ---- Ghost mode banner persistence helpers ----
function ghostBannerKey(groupId) {
    return `ghost_session_banners_${groupId}`;
}

function getGhostBanners(groupId) {
    try {
        const raw = localStorage.getItem(ghostBannerKey(groupId));
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function setGhostBanners(groupId, banners) {
    try { localStorage.setItem(ghostBannerKey(groupId), JSON.stringify(banners)); } catch {}
}

function recordGhostBanner(groupId, text) {
    const banners = getGhostBanners(groupId);
    banners.push(text);
    setGhostBanners(groupId, banners);
}

function renderGhostBannersForCurrentGroup() {
    if (!currentGroup) return;
    const banners = getGhostBanners(currentGroup.id);
    if (banners.length === 0 && currentGroup.ghost_mode) {
        // First-time enable without prior record
        banners.push('Ghost mode started');
        setGhostBanners(currentGroup.id, banners);
    }
    banners.forEach(text => addHistorySeparator(text));
}
// Flexible ISO parser to handle fractional seconds with >3 digits
function parseISOToMs(iso) {
    if (!iso || typeof iso !== 'string') return NaN;
    let t = Date.parse(iso);
    if (!isNaN(t)) return t;
    // Trim fractional seconds to 3 digits if present
    let s = iso.replace(/\.(\d{3})\d+/, '.$1');
    t = Date.parse(s);
    if (!isNaN(t)) return t;
    // Remove fractional seconds completely
    s = iso.replace(/\.\d+/, '');
    t = Date.parse(s);
    if (!isNaN(t)) return t;
    return NaN;
}

function getRTCPeerConfig() {
    return { iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
    ]};
}

async function startCall() {
    if (!currentConversation) { alert('Select a contact to call.'); return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    await ensureMedia();
    await ensurePeerConnection();
    currentCallPeer = currentConversation;

    // Create offer
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.send(JSON.stringify({
        type: 'call_offer',
        target_username: currentCallPeer,
        sdp: JSON.stringify(offer)
    }));
    openCallModal();
}

async function ensureMedia() {
    if (localStream) return;
    try {
        const md = (typeof navigator !== 'undefined') ? navigator.mediaDevices : undefined;
        if (!md || !md.getUserMedia) {
            console.warn('MediaDevices.getUserMedia not available; proceeding without local tracks');
            return; // allow recv-only; remote can still appear
        }
        localStream = await md.getUserMedia({ video: true, audio: true });
        const localVideo = document.getElementById('localVideo');
        if (localVideo) localVideo.srcObject = localStream;
    } catch (err) {
        console.error('getUserMedia failed, proceeding without local tracks:', err);
        // Keep going without local tracks so remote video can still be received
        localStream = null;
    }
}

async function ensurePeerConnection() {
    if (pc) return;
    pc = new RTCPeerConnection(getRTCPeerConfig());
    remoteStream = new MediaStream();
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = remoteStream;

    if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    } else if (pc.addTransceiver) {
        // Ensure we can still receive remote media without local tracks
        try { pc.addTransceiver('video', { direction: 'recvonly' }); } catch {}
        try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}
    }
    pc.ontrack = (e) => {
        e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    };
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.send(JSON.stringify({
                type: 'call_ice',
                target_username: currentCallPeer || currentConversation,
                candidate: JSON.stringify(e.candidate)
            }));
        }
    };
    // Try to flush any ICE received before pc was ready
    try {
        if (pendingIceCandidates && pendingIceCandidates.length > 0) {
            const toApply = pendingIceCandidates.slice();
            pendingIceCandidates = [];
            for (const cand of toApply) {
                await pc.addIceCandidate(cand);
            }
        }
    } catch (err) {
        console.error('Failed applying queued ICE', err);
    }
}

function openCallModal() {
    const m = document.getElementById('call-modal');
    if (m) m.style.display = 'block';
}
function closeCallModal() {
    const m = document.getElementById('call-modal');
    if (m) m.style.display = 'none';
}

async function endCall(sendSignal = true) {
    try {
        if (sendSignal && socket && socket.readyState === WebSocket.OPEN && currentConversation) {
            socket.send(JSON.stringify({ type: 'call_end', target_username: currentConversation }));
        }
        if (pc) { pc.close(); pc = null; }
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        remoteStream = null;
        closeCallModal();
    } catch {}
}
let pendingFile = null;
let gameModal, closeGameModal, gameContainer, gameBoard, gameInfo, gameControls;
let currentGame = null;

// DOM element variables (will be set after DOM loads)
let authContainer, messengerContainer, loginForm, registerForm;
let showRegisterLink, showLoginLink, loginBtn, registerBtn, logoutBtn;
let currentUserSpan, contactsList, groupsList, availableGroupsList, welcomeScreen, chatHeader;
let messagesContainer, messageInputArea, messagesDiv, messageInput, sendBtn;
let chatWithUsername, imageInput, imageBtn;
let globalLockBtn, globalLockDropdown, globalLockSet, globalLockEnable, globalLockDisable, globalLockChange;
let dmLockBtn, dmLockModal, closeDMLockModal, dmLockPin, dmLockPinConfirm, dmLockTitle, dmLockPrimary, dmLockSecondary;
let createGroupBtn, createGroupModal, closeGroupModal, submitGroupBtn;
let groupNameInput, groupDescInput, groupMembersInput;
let searchInput, searchBtn, searchResults;

// Group management elements
let groupMenu, groupMenuBtn, groupMenuDropdown;
let addMembersBtn, viewMembersBtn, editGroupBtn, leaveGroupBtn, toggleGhostBtn;
let addMembersModal, closeAddMembersModal, newMembersInput, submitAddMembersBtn;
let viewMembersModal, closeViewMembersModal, membersList;

// Poll elements
let createPollModal, closePollModal, submitPollBtn;
let pollQuestionInput, pollOptionsContainer, addPollOptionBtn;
let allowMultipleCheckbox, pollExpiresInput;
let activePollsContainer;

// AI Assistant variables
let aiAssistantOpen = false;
let aiAssistantWidget, aiAssistantToggle, aiAssistantChat, aiAssistantClose;
let aiMessagesContainer, aiMessageInput, aiSendBtn;

// Split pane globals
let splitOpenBtn, splitPane2, chatHeader2, chatWithUsername2, messagesContainer2, messagesDiv2, messageInputArea2, messageInput2, sendBtn2;
let splitAddChatBtn, splitContactsSelect, splitCloseBtn;
let currentConversation2 = null;
let currentGroup2 = null;
let pane2ExpectedHistory = null;
let splitEnabled = false; // temporarily disabled to restore original layout

// ==========================
// Helper Functions
// ==========================
// Message Search Variables
let allMessages = [];
let typingTimeout = null;

function showAuthInterface() {
    authContainer.style.display = 'flex';
    messengerContainer.style.display = 'none';
}

function showMessengerInterface() {
    authContainer.style.display = 'none';
    messengerContainer.style.display = 'flex';
    currentUserSpan.textContent = currentUser;
    // Show sidebar toggle when app is visible
    const btn = document.getElementById('sidebar-toggle-btn');
    if (btn) btn.style.display = 'inline-block';
    connectWebSocket();
}

function showLoginForm() {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
    clearErrors();
}

function showRegisterForm() {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
    clearErrors();
}

function clearErrors() {
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('register-error').style.display = 'none';
}

function showError(element, message) {
    element.textContent = message;
    element.style.display = 'block';
}

function getCurrentTime() {
    return new Date().toTimeString().split(' ')[0];
}

function clearMessages() {
    messagesDiv.innerHTML = '';
}

function clearContacts() {
    contactsList.innerHTML = '';
    contacts = [];
}

function clearGroups() {
    groupsList.innerHTML = '';
    if (availableGroupsList) availableGroupsList.innerHTML = '';
    memberGroups = [];
    availableGroups = [];
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Initialize AI Assistant after DOM loads
function initializeAIAssistant() {
    aiAssistantWidget = document.getElementById('ai-assistant-widget');
    aiAssistantToggle = document.getElementById('ai-assistant-toggle');
    aiAssistantChat = document.getElementById('ai-assistant-chat');
    aiAssistantClose = document.getElementById('ai-assistant-close');
    aiMessagesContainer = document.getElementById('ai-assistant-messages');
    aiMessageInput = document.getElementById('ai-message-input');
    aiSendBtn = document.getElementById('ai-send-btn');

    if (!aiAssistantWidget) return;

    // Event listeners
    aiAssistantToggle.addEventListener('click', toggleAIAssistant);
    aiAssistantClose.addEventListener('click', closeAIAssistant);
    aiSendBtn.addEventListener('click', sendAIMessage);
    
    aiMessageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAIMessage();
        }
    });

    // Auto-resize textarea
    aiMessageInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 80) + 'px';
    });

    // Show widget if user is logged in (check both current session and localStorage)
    if (currentUser && authToken) {
        console.log('Showing AI Assistant for logged in user');
        aiAssistantWidget.style.display = 'block';
    }
}

function toggleAIAssistant() {
    aiAssistantOpen = !aiAssistantOpen;
    if (aiAssistantOpen) {
        aiAssistantChat.classList.add('open');
        aiMessageInput.focus();
    } else {
        aiAssistantChat.classList.remove('open');
    }
}

function closeAIAssistant() {
    aiAssistantOpen = false;
    aiAssistantChat.classList.remove('open');
}

function showAIAssistant() {
    if ((currentUser && authToken) || (localStorage.getItem('currentUser') && localStorage.getItem('authToken'))) {
        console.log('Showing AI Assistant');
        if (aiAssistantWidget) {
            aiAssistantWidget.style.display = 'block';
        }
    }
}

function hideAIAssistant() {
    aiAssistantWidget.style.display = 'none';
    closeAIAssistant();
}

async function sendAIMessage() {
    const message = aiMessageInput.value.trim();
    if (!message || !authToken) return;

    // Add user message to chat
    addAIMessage(message, 'user');
    aiMessageInput.value = '';
    aiMessageInput.style.height = 'auto';

    // Show typing indicator
    showAITyping();

    try {
        const response = await fetch('/ai/assistant', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                query: message,
                context_type: currentGroup ? 'group' : (currentConversation ? 'conversation' : 'general'),
                target_name: currentGroup ? currentGroup.name : currentConversation
            })
        });

        const data = await response.json();
        
        // Remove typing indicator
        hideAITyping();

        if (response.ok && data.success) {
            addAIMessage(data.response, 'bot');
        } else {
            addAIMessage(data.response || 'Sorry, I encountered an error. Please try again.', 'bot');
        }

    } catch (error) {
        hideAITyping();
        addAIMessage('Sorry, I\'m having trouble connecting. Please try again later.', 'bot');
        console.error('AI Assistant error:', error);
    }
}

function sendQuickMessage(message) {
    aiMessageInput.value = message;
    sendAIMessage();
}

function addAIMessage(message, sender) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `ai-message ${sender}`;
    
    const content = document.createElement('div');
    content.innerHTML = formatAIMessage(message);
    
    const time = document.createElement('div');
    time.className = 'ai-message-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    messageDiv.appendChild(content);
    messageDiv.appendChild(time);
    
    aiMessagesContainer.appendChild(messageDiv);
    aiMessagesContainer.scrollTop = aiMessagesContainer.scrollHeight;
}

function formatAIMessage(message) {
    // Format markdown-like text
    return message
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>')
        .replace(/â€¢/g, '•');
}

function showAITyping() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'ai-typing-indicator';
    typingDiv.id = 'ai-typing-indicator';
    
    typingDiv.innerHTML = `
        <div class="ai-typing-dots">
            <div class="ai-typing-dot"></div>
            <div class="ai-typing-dot"></div>
            <div class="ai-typing-dot"></div>
        </div>
        <span>AI is thinking...</span>
    `;
    
    aiMessagesContainer.appendChild(typingDiv);
    aiMessagesContainer.scrollTop = aiMessagesContainer.scrollHeight;
}

function hideAITyping() {
    const typingIndicator = document.getElementById('ai-typing-indicator');
    if (typingIndicator) {
        typingIndicator.remove();
    }
}

// Call this when user logs in
function onUserLogin() {
    showAIAssistant();
}

// Call this when user logs out  
function onUserLogout() {
    hideAIAssistant();
}

// Initialize game elements - FIXED
function initializeGameElements() {
    console.log('Initializing game elements...');
    
    // Try to initialize game modal elements multiple times if needed
    const tryInitialize = () => {
        gameModal = document.getElementById('game-modal');
        closeGameModal = document.getElementById('close-game-modal');
        gameContainer = document.getElementById('game-container');
        gameBoard = document.getElementById('game-board');
        gameInfo = document.getElementById('game-info');
        gameControls = document.getElementById('game-controls');
        
        if (!gameModal) {
            console.warn('Game modal not found, will retry when needed');
            return false;
        }
        
        // Add close event listener
        if (closeGameModal) {
            closeGameModal.addEventListener('click', () => {
                gameModal.style.display = 'none';
                currentGame = null;
            });
        }
        
        // Close modal on outside click
        gameModal.addEventListener('click', (e) => {
            if (e.target === gameModal) {
                gameModal.style.display = 'none';
                currentGame = null;
            }
        });
        
        console.log('Game elements initialized successfully');
        return true;
    };
    
    // Try to initialize immediately
    if (!tryInitialize()) {
        // If it fails, we'll try again when displayGame is called
        console.log('Game elements initialization deferred');
    }
}

// Game creation function - UPDATED
function createGame(gameType) {
    console.log('Creating game of type:', gameType);
    console.log('Current conversation:', currentConversation);
    console.log('Current group:', currentGroup);
    console.log('Socket state:', socket ? socket.readyState : 'no socket');

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        alert('Connection error. Please try again.');
        return;
    }

    const gameMessage = {
        type: 'create_game',
        game_type: gameType
    };

    if (currentGroup) {
        gameMessage.group_id = currentGroup.id;
        console.log('Creating game in group:', currentGroup.id);
    } else if (currentConversation) {
        gameMessage.target_username = currentConversation;
        console.log('Creating game with user:', currentConversation);
    } else {
        alert('Please select a conversation or group first');
        return;
    }

    console.log('Sending game creation message:', gameMessage);
    socket.send(JSON.stringify(gameMessage));
    
    // Show loading indicator
    showNotification(`Creating ${getGameName(gameType)} game...`, 'info');
}

// Display game message in chat - IMPROVED FOR GAME JOINING
function displayGameMessage(message, historical = false) {
    if (message.message && message.message.includes('🎮')) {
        const existingMessage = document.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMessage && message.id) {
            return;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${message.sender_username === currentUser ? 'sent' : 'received'} game-message`;
        msgDiv.dataset.messageId = message.id;
        if (historical) msgDiv.classList.add('historical');

        const header = document.createElement('div');
        header.className = 'message-header';
        const displayNameGame = (currentGroup && currentGroup.ghost_mode && message.group_id) ? 'Anonymous' : message.sender_username;
        header.textContent = `${displayNameGame} • ${message.timestamp}`;

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = message.message;

        const gameButton = document.createElement('button');
        gameButton.className = 'game-view-btn';
        
        if (message.message.includes('created') || message.message.includes('started')) {
            // For newly created games, show appropriate button based on who created it
            if (message.sender_username === currentUser) {
                gameButton.textContent = 'View Game';
            } else {
                gameButton.textContent = 'Join Game';
            }
            const gameId = extractGameId(message.message);
            gameButton.addEventListener('click', () => {
                if (message.sender_username === currentUser) {
                    loadGame(gameId);
                } else {
                    joinGame(gameId);
                }
            });
        } else if (message.message.includes('made a move')) {
            gameButton.textContent = 'View Game';
            const gameId = extractGameId(message.message);
            gameButton.addEventListener('click', () => loadGame(gameId));
        }

        msgDiv.appendChild(header);
        msgDiv.appendChild(content);
        msgDiv.appendChild(gameButton);
        
        messagesDiv.appendChild(msgDiv);
        if (!historical) scrollToBottom();
    } else {
        displayMessage(message, historical);
    }
}

function extractGameId(message) {
    const match = message.match(/Game ID: (\d+)|game #(\d+)/);
    return match ? parseInt(match[1] || match[2]) : null;
}

function joinGame(gameId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        alert('Connection error. Please try again.');
        return;
    }

    console.log('Joining game:', gameId);
    socket.send(JSON.stringify({
        type: 'join_game',
        game_id: gameId
    }));
    
    showNotification('Joining game...', 'info');
}

function loadGame(gameId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        alert('Connection error. Please try again.');
        return;
    }

    console.log('Loading game:', gameId);
    socket.send(JSON.stringify({
        type: 'get_game_state',
        game_id: gameId
    }));
}

// COMPLETELY NEW SAFE DISPLAY GAME FUNCTION
function displayGame(game) {
    console.log('=== displayGame called ===');
    console.log('Game data:', game);
    
    // Get elements directly from DOM every time
    const modal = document.getElementById('game-modal');
    const info = document.getElementById('game-info');
    const board = document.getElementById('game-board');
    
    console.log('DOM elements found:');
    console.log('modal:', modal);
    console.log('info:', info);
    console.log('board:', board);
    
    if (!modal) {
        console.error('CRITICAL: game-modal element not found');
        alert('Game modal not found. Check HTML structure.');
        return;
    }
    
    if (!info) {
        console.error('CRITICAL: game-info element not found');
        alert('Game info element not found. Check HTML structure.');
        return;
    }
    
    if (!board) {
        console.error('CRITICAL: game-board element not found');
        alert('Game board element not found. Check HTML structure.');
        return;
    }
    
    // Set global variables
    gameModal = modal;
    gameInfo = info;
    gameBoard = board;
    currentGame = game;
    
    console.log('About to set modal style...');
    
    try {
        modal.style.display = 'block';
        console.log('Modal display set to block');
    } catch (error) {
        console.error('Error setting modal style:', error);
        alert('Error showing game modal: ' + error.message);
        return;
    }
    
    console.log('About to set game info...');
    
    try {
        info.innerHTML = `
            <div class="game-header">
                <h3>${getGameIcon(game.game_type)} ${getGameName(game.game_type)}</h3>
                <div class="game-players">
                    <span class="player player1">${game.player1_username}</span>
                    ${game.player2_username ? 
                        `<span class="vs">vs</span><span class="player player2">${game.player2_username}</span>` :
                        '<span class="waiting">Waiting for player...</span>'
                    }
                </div>
                <div class="game-status">${getGameStatus(game)}</div>
            </div>
        `;
        console.log('Game info set successfully');
    } catch (error) {
        console.error('Error setting game info:', error);
        alert('Error setting game info: ' + error.message);
        return;
    }

    console.log('About to display game board...');
    
    try {
        // Display game board based on type
        switch (game.game_type) {
            case 'chess':
                console.log('Displaying chess board');
                displayChessBoard(game);
                break;
            case 'tictactoe':
                console.log('Displaying tic-tac-toe board');
                displayTicTacToeBoard(game);
                break;
            case 'trivia':
                console.log('Displaying trivia game');
                displayTriviaGame(game);
                break;
            default:
                console.warn('Unknown game type:', game.game_type);
        }
        console.log('Game board displayed successfully');
    } catch (error) {
        console.error('Error displaying game board:', error);
        alert('Error displaying game board: ' + error.message);
        return;
    }
    
    console.log('=== displayGame completed successfully ===');
}

function getGameIcon(gameType) {
    switch (gameType) {
        case 'chess': return '♟️';
        case 'tictactoe': return '⭕';
        case 'trivia': return '🧠';
        default: return '🎮';
    }
}

function getGameName(gameType) {
    switch (gameType) {
        case 'chess': return 'Chess';
        case 'tictactoe': return 'Tic-Tac-Toe';
        case 'trivia': return 'Trivia';
        default: return 'Game';
    }
}

function getGameStatus(game) {
    if (game.status === 'finished') {
        if (game.winner === 'draw') {
            return "🤝 Game ended in a draw";
        } else if (game.winner === currentUser) {
            return "🏆 You won!";
        } else {
            return `🏆 ${game.winner} wins!`;
        }
    } else if (game.status === 'waiting') {
        // Improve waiting status messaging
        if (game.player1_username === currentUser) {
            return "⏳ Waiting for another player to join. Share the game ID with someone!";
        } else {
            return "⏳ Waiting for another player to join";
        }
    } else if (game.game_type === 'trivia') {
        // Special handling for trivia games
        const gameState = JSON.parse(game.game_state);
        const answered = gameState.answered || [];
        
        if (answered.includes(currentUser)) {
            if (answered.length === 1) {
                const otherPlayer = game.player1_username === currentUser ? game.player2_username : game.player1_username;
                return `⏳ Waiting for ${otherPlayer} to answer`;
            } else {
                return "⏳ All players answered - processing results...";
            }
        } else {
            return "🎯 Your turn to answer the question!";
        }
    } else if (game.current_turn === currentUser) {
        return "🎯 Your turn - make your move!";
    } else {
        return `⏳ ${game.current_turn}'s turn`;
    }
}

// Chess board display
function displayChessBoard(game) {
    const gameState = JSON.parse(game.game_state);
    const board = gameState.board;
    
    gameBoard.innerHTML = '<div class="chess-board"></div>';
    const chessBoard = gameBoard.querySelector('.chess-board');
    
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const square = document.createElement('div');
            square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
            square.dataset.row = row;
            square.dataset.col = col;
            
            const piece = board[row][col];
            if (piece !== '.') {
                square.textContent = getChessPieceSymbol(piece);
                square.classList.add('has-piece');
            }
            
            if (game.current_turn === currentUser && game.status === 'active') {
                square.addEventListener('click', () => handleChessSquareClick(row, col));
            }
            
            chessBoard.appendChild(square);
        }
    }
}

function getChessPieceSymbol(piece) {
    const symbols = {
        'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙',
        'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟'
    };
    return symbols[piece] || piece;
}

let selectedChessSquare = null;

function handleChessSquareClick(row, col) {
    if (!selectedChessSquare) {
        // Select piece
        const square = document.querySelector(`[data-row="${row}"][data-col="${col}"]`);
        if (square.classList.contains('has-piece')) {
            selectedChessSquare = { row, col };
            square.classList.add('selected');
        }
    } else {
        // Make move
        const moveData = {
            from: [selectedChessSquare.row, selectedChessSquare.col],
            to: [row, col]
        };
        
        makeGameMove(JSON.stringify(moveData));
        
        // Clear selection
        document.querySelector('.selected')?.classList.remove('selected');
        selectedChessSquare = null;
    }
}

// Tic-tac-toe board display - IMPROVED FOR WAITING STATE
function displayTicTacToeBoard(game) {
    const gameState = JSON.parse(game.game_state);
    const board = gameState.board;
    
    gameBoard.innerHTML = '<div class="tictactoe-board"></div>';
    const tictactoeBoard = gameBoard.querySelector('.tictactoe-board');
    
    // If game is waiting for a second player, show a message
    if (game.status === 'waiting') {
        const waitingMessage = document.createElement('div');
        waitingMessage.className = 'waiting-for-player';
        waitingMessage.innerHTML = `
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px; margin-bottom: 20px;">
                <h4>🎮 Game ID: ${game.id}</h4>
                <p>Share this Game ID with someone so they can join!</p>
                ${game.player1_username !== currentUser ? '<p><strong>Click "Join Game" to start playing!</strong></p>' : ''}
            </div>
        `;
        gameBoard.insertBefore(waitingMessage, tictactoeBoard);
    }
    
    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            const square = document.createElement('div');
            square.className = 'tictactoe-square';
            square.dataset.row = row;
            square.dataset.col = col;
            square.textContent = board[row][col];
            
            // Only allow clicks if:
            // 1. Game is active (not waiting)
            // 2. It's current user's turn  
            // 3. Square is empty
            if (game.status === 'active' && game.current_turn === currentUser && !board[row][col]) {
                square.addEventListener('click', () => handleTicTacToeClick(row, col));
                square.classList.add('clickable');
            } else if (game.status === 'waiting') {
                // Show that squares are not clickable yet
                square.classList.add('waiting');
            }
            
            tictactoeBoard.appendChild(square);
        }
    }
}

function handleTicTacToeClick(row, col) {
    const moveData = { row, col };
    makeGameMove(JSON.stringify(moveData));
}

// Trivia game display - ENHANCED WITH BETTER STATE HANDLING
function displayTriviaGame(game) {
    const gameState = JSON.parse(game.game_state);
    const question = gameState.current_question;
    const scores = gameState.scores || {};
    const answered = gameState.answered || [];
    
    console.log('Displaying trivia game state:', gameState);
    console.log('Players answered:', answered);
    console.log('Current scores:', scores);
    
    gameBoard.innerHTML = `
        <div class="trivia-game">
            <div class="trivia-scores">
                <h4>Scores:</h4>
                <div class="score-list">
                    <div class="score-item">
                        <span>${game.player1_username}:</span>
                        <span>${scores[game.player1_username] || 0}</span>
                    </div>
                    ${game.player2_username ? `
                        <div class="score-item">
                            <span>${game.player2_username}:</span>
                            <span>${scores[game.player2_username] || 0}</span>
                        </div>
                    ` : ''}
                </div>
            </div>
            
            <div class="trivia-question">
                <div class="question-category">${question ? question.category : 'Loading...'}</div>
                <div class="question-text">${question ? question.question : 'Loading question...'}</div>
                
                ${!question ? 
                    '<div class="loading-notice">Loading next question...</div>' :
                    answered.includes(currentUser) ? 
                        `<div class="answered-notice">
                            <p><strong>You have answered this question!</strong></p>
                            ${answered.length < 2 ? 
                                `<p>Waiting for ${answered.length === 1 && game.player2_username ? 
                                    (currentUser === game.player1_username ? game.player2_username : game.player1_username) + ' to answer...' : 
                                    'other players to answer...'}</p>` :
                                '<p>All players have answered! Processing results...</p>'
                            }
                            <div class="answered-players">
                                <p>Answered: ${answered.join(', ')}</p>
                            </div>
                            ${answered.length >= 2 ? 
                                '<button class="next-question-btn" onclick="requestNextQuestion()">Continue to Next Question</button>' : ''
                            }
                        </div>` : 
                        `<div class="question-options">
                            ${question.options.map((option, index) => `
                                <button class="trivia-option" 
                                        data-answer="${index}">
                                    ${option}
                                </button>
                            `).join('')}
                        </div>
                        <div class="answer-prompt">Choose your answer:</div>`
                }
            </div>
        </div>
    `;
    
    // Add click handlers for options only if user hasn't answered and question exists
    if (question && !answered.includes(currentUser) && game.status === 'active') {
        const options = gameBoard.querySelectorAll('.trivia-option');
        options.forEach(option => {
            option.addEventListener('click', () => {
                const answer = parseInt(option.dataset.answer);
                console.log('Trivia answer selected:', answer);
                handleTriviaAnswer(answer);
            });
        });
    }
}

// Add function to request next question
function requestNextQuestion() {
    if (!currentGame || !socket || socket.readyState !== WebSocket.OPEN) {
        console.error('Cannot request next question: no game or connection');
        return;
    }
    
    console.log('Requesting next question for game:', currentGame.id);
    
    socket.send(JSON.stringify({
        type: 'game_move',
        game_id: currentGame.id,
        game_move: JSON.stringify({
            action: 'next_question',
            player: currentUser
        })
    }));
}

function handleTriviaAnswer(answer) {
    if (!currentGame) {
        console.error('No current game set');
        return;
    }
    
    console.log('=== TRIVIA ANSWER WORKAROUND ===');
    console.log('Using chat-based trivia answer system');
    console.log('Answer selected:', answer);
    
    // Check if user has already answered
    const gameState = JSON.parse(currentGame.game_state);
    const answered = gameState.answered || [];
    
    if (answered.includes(currentUser)) {
        console.log('User has already answered this question');
        alert('You have already answered this question!');
        return;
    }
    
    // Instead of using game_move, send as a special chat message
    // This bypasses the turn validation completely
    if (socket && socket.readyState === WebSocket.OPEN) {
        const triviaAnswerMessage = {
            type: 'chat_message',
            receiver_username: currentConversation,
            group_id: currentGroup ? currentGroup.id : null,
            message: `🧠 TRIVIA_ANSWER:${currentGame.id}:${answer}:${currentUser}:${Date.now()}`,
            timestamp: getCurrentTime()
        };
        
        console.log('Sending trivia answer via chat message:', triviaAnswerMessage);
        socket.send(JSON.stringify(triviaAnswerMessage));
        
        // Disable answer options immediately
        const options = gameBoard.querySelectorAll('.trivia-option');
        options.forEach(option => {
            option.disabled = true;
            option.style.opacity = '0.5';
            option.style.cursor = 'not-allowed';
        });
        
        // Show immediate feedback
        const answerPrompt = gameBoard.querySelector('.answer-prompt');
        if (answerPrompt) {
            answerPrompt.innerHTML = `<div style="color: #28a745; font-weight: bold;">Answer ${answer + 1} submitted! Waiting for other players...</div>`;
        }
        
        // Update local game state to show user has answered
        const updatedGameState = JSON.parse(currentGame.game_state);
        updatedGameState.answered = updatedGameState.answered || [];
        if (!updatedGameState.answered.includes(currentUser)) {
            updatedGameState.answered.push(currentUser);
        }
        currentGame.game_state = JSON.stringify(updatedGameState);
        
        console.log('Updated local game state:', updatedGameState);
        console.log('=== END TRIVIA ANSWER WORKAROUND ===');
        
        // Refresh the display to show updated state
        displayTriviaGame(currentGame);
    } else {
        console.error('WebSocket not connected');
        alert('Connection error. Please try again.');
    }
}

// Make a move in the current game
function makeGameMove(moveData) {
    if (!currentGame || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    socket.send(JSON.stringify({
        type: 'game_move',
        game_id: currentGame.id,
        game_move: moveData
    }));
    
    // Disable game interactions temporarily
    disableGameInteractions();
    
    // Re-enable after a short delay (will be overridden by game update)
    setTimeout(enableGameInteractions, 2000);
}

function disableGameInteractions() {
    if (gameBoard) {
        gameBoard.style.pointerEvents = 'none';
        gameBoard.style.opacity = '0.7';
    }
}

function enableGameInteractions() {
    if (gameBoard) {
        gameBoard.style.pointerEvents = 'auto';
        gameBoard.style.opacity = '1';
    }
}

// Handle game-specific WebSocket messages - FIXED
function handleGameWebSocketMessage(data) {
    console.log('Handling game WebSocket message:', data);
    
    switch (data.type) {
        case 'game_state':
            console.log('Calling displayGame from game_state');
            displayGame(data.game);
            break;
        case 'game_update':
            if (currentGame && currentGame.id === data.game.id) {
                console.log('Calling displayGame from game_update');
                displayGame(data.game);
            }
            // Also show a notification if game finished
            if (data.game.status === 'finished') {
                showGameFinishedNotification(data.game);
            }
            break;
        case 'game_created':
            console.log('Game created:', data.game);
            // Optionally auto-open the game
            if (data.game.player1_username === currentUser) {
                console.log('Auto-opening game for creator');
                setTimeout(() => {
                    console.log('Calling displayGame from game_created timeout');
                    displayGame(data.game);
                }, 500);
            }
            break;
        case 'game_joined':
            console.log('Game joined:', data.game);
            // Auto-open the game for the joining player
            setTimeout(() => {
                console.log('Calling displayGame from game_joined timeout');
                displayGame(data.game);
            }, 500);
            break;
        case 'game_error':
            console.error('Game error:', data.error);
            alert('Game error: ' + data.error);
            break;
    }
}

function showGameFinishedNotification(game) {
    console.log('=== GAME FINISHED NOTIFICATION DEBUG ===');
    console.log('Game:', game);
    console.log('Current user:', currentUser);
    console.log('Player1:', game.player1_username);
    console.log('Player2:', game.player2_username);
    console.log('Winner:', game.winner);
    console.log('Game status:', game.status);
    
    // Check if current user is part of this game
    const isPlayer1 = game.player1_username === currentUser;
    const isPlayer2 = game.player2_username === currentUser;
    const isMyGame = isPlayer1 || isPlayer2;
    
    console.log('Is my game:', isMyGame);
    console.log('Am I player1:', isPlayer1);
    console.log('Am I player2:', isPlayer2);
    
    if (!isMyGame) {
        console.log('Not my game, skipping notification');
        return;
    }
    
    if (game.winner === 'draw') {
        console.log('Showing draw notification');
        showNotification('Game ended in a draw! 🤝', 'info');
    } else if (game.winner === currentUser) {
        console.log('Showing win notification');
        showNotification('Congratulations! You won! 🏆', 'success');
    } else {
        console.log('Showing lose notification');
        const opponent = isPlayer1 ? game.player2_username : game.player1_username;
        showNotification(`Game finished. ${opponent} won! Better luck next time.`, 'info');
    }
    
    console.log('=== END GAME FINISHED NOTIFICATION DEBUG ===');
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8'};
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        z-index: 10000;
        font-weight: 500;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        animation: slideInRight 0.3s ease-out;
    `;
    
    document.body.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOutRight 0.3s ease-out';
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 5000);
}

// ==========================
// Event Handlers
// ==========================
function setupEventListeners() {
    showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); showRegisterForm(); });
    showLoginLink.addEventListener('click', (e) => { e.preventDefault(); showLoginForm(); });
    loginBtn.addEventListener('click', handleLogin);
    registerBtn.addEventListener('click', handleRegister);
    logoutBtn.addEventListener('click', handleLogout);
    sendBtn.addEventListener('click', sendMessage);

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', sendImage);

    // Sidebar mini-search listeners
    const cs = document.getElementById('contacts-search');
    if (cs) cs.addEventListener('input', displayContacts);
    const gs = document.getElementById('groups-search');
    if (gs) gs.addEventListener('input', displayGroups);
    const ags = document.getElementById('available-groups-search');
    if (ags) ags.addEventListener('input', displayGroups);
    const ns = document.getElementById('notes-search');
    if (ns) ns.addEventListener('input', displayNotes);

    document.getElementById('login-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
    });
    document.getElementById('register-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleRegister();
    });

    // Group creation modal event listeners
    if (createGroupBtn && createGroupModal) {
        createGroupBtn.addEventListener('click', () => { 
            createGroupModal.style.display = 'block'; 
        });
    }

    if (closeGroupModal) {
        closeGroupModal.addEventListener('click', () => { 
            createGroupModal.style.display = 'none'; 
        });
    }

    if (submitGroupBtn) {
        submitGroupBtn.addEventListener('click', createGroup);
    }

    // Group management event listeners
    if (groupMenuBtn) {
        groupMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            groupMenuDropdown.classList.toggle('show');
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
        if (groupMenuDropdown) {
            groupMenuDropdown.classList.remove('show');
        }
    });

    // Group menu item listeners
    if (addMembersBtn) {
        addMembersBtn.addEventListener('click', () => {
            groupMenuDropdown.classList.remove('show');
            addMembersModal.style.display = 'block';
        });
    }

    if (viewMembersBtn) {
        viewMembersBtn.addEventListener('click', () => {
            groupMenuDropdown.classList.remove('show');
            showGroupMembers();
        });
    }

    if (editGroupBtn) {
        editGroupBtn.addEventListener('click', () => {
            groupMenuDropdown.classList.remove('show');
            editGroup();
        });
    }

    if (leaveGroupBtn) {
        leaveGroupBtn.addEventListener('click', () => {
            groupMenuDropdown.classList.remove('show');
            leaveGroup();
        });
    }

    // Ghost mode toggle
    if (toggleGhostBtn) {
        toggleGhostBtn.addEventListener('click', async () => {
            groupMenuDropdown.classList.remove('show');
            if (!currentGroup) return;
            const newState = !Boolean(currentGroup.ghost_mode);
            try {
                const resp = await fetch('/groups/update', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                    body: JSON.stringify({ group_id: currentGroup.id, ghost_mode: newState })
                });
                if (!resp.ok) {
                    const t = await resp.text();
                    alert('Failed to update ghost mode: ' + t);
                    return;
                }
                currentGroup.ghost_mode = newState;
                updateGhostToggleLabel();
                try { localStorage.setItem(`ghost_mode_group_${currentGroup.id}`, newState ? '1' : '0'); } catch {}
                // Record banner and refresh conversation
                const notice = newState ? 'Ghost mode started' : 'Ghost mode ended';
                recordGhostBanner(currentGroup.id, notice);
                pendingGhostNotice = null;
                loadGroupConversation(currentGroup.id);
            } catch (e) {
                console.error('Toggle ghost failed', e);
                alert('Failed to toggle ghost mode');
            }
        });
    }

    // Poll menu item listener
    const createPollMenuBtn = document.getElementById('create-poll-menu-btn');
    if (createPollMenuBtn) {
        createPollMenuBtn.addEventListener('click', () => {
            groupMenuDropdown.classList.remove('show');
            showCreatePollModal();
        });
    }

    // Add members modal listeners
    if (closeAddMembersModal) {
        closeAddMembersModal.addEventListener('click', () => {
            addMembersModal.style.display = 'none';
        });
    }

    if (submitAddMembersBtn) {
        submitAddMembersBtn.addEventListener('click', addMembersToGroup);
    }

    // View members modal listeners
    if (closeViewMembersModal) {
        closeViewMembersModal.addEventListener('click', () => {
            viewMembersModal.style.display = 'none';
        });
    }

    // Poll creation event listeners
    if (addPollOptionBtn) {
        addPollOptionBtn.addEventListener('click', addPollOption);
    }
    
    if (closePollModal) {
        closePollModal.addEventListener('click', () => {
            createPollModal.style.display = 'none';
            resetPollForm();
        });
    }
    
    if (submitPollBtn) {
        submitPollBtn.addEventListener('click', createPoll);
    }

    // Close modals when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === createGroupModal) createGroupModal.style.display = 'none';
        if (e.target === addMembersModal) addMembersModal.style.display = 'none';
        if (e.target === viewMembersModal) viewMembersModal.style.display = 'none';
        if (e.target === createPollModal) {
            createPollModal.style.display = 'none';
            resetPollForm();
        }
    });
}

// ==========================
// Poll Functions
// ==========================
function showCreatePollModal() {
    if (!currentGroup) {
        alert('No group selected');
        return;
    }
    
    resetPollForm();
    createPollModal.style.display = 'block';
}

function resetPollForm() {
    pollQuestionInput.value = '';
    allowMultipleCheckbox.checked = false;
    pollExpiresInput.value = '';
    
    // Reset poll options to default 2 options
    pollOptionsContainer.innerHTML = `
        <div class="poll-option-input">
            <input type="text" placeholder="Option 1" required>
            <button type="button" class="remove-option-btn" onclick="removePollOption(this)">✕</button>
        </div>
        <div class="poll-option-input">
            <input type="text" placeholder="Option 2" required>
            <button type="button" class="remove-option-btn" onclick="removePollOption(this)">✕</button>
        </div>
    `;
}

function addPollOption() {
    const optionCount = pollOptionsContainer.children.length;
    if (optionCount >= 10) {
        alert('Maximum 10 options allowed');
        return;
    }
    
    const optionDiv = document.createElement('div');
    optionDiv.className = 'poll-option-input';
    optionDiv.innerHTML = `
        <input type="text" placeholder="Option ${optionCount + 1}" required>
        <button type="button" class="remove-option-btn" onclick="removePollOption(this)">✕</button>
    `;
    
    pollOptionsContainer.appendChild(optionDiv);
}

function removePollOption(button) {
    const optionDiv = button.parentElement;
    if (pollOptionsContainer.children.length > 2) {
        optionDiv.remove();
        
        // Update placeholders
        Array.from(pollOptionsContainer.children).forEach((div, index) => {
            const input = div.querySelector('input');
            input.placeholder = `Option ${index + 1}`;
        });
    } else {
        alert('Minimum 2 options required');
    }
}

function createPoll() {
    if (!currentGroup) {
        alert('No group selected');
        return;
    }
    
    const question = pollQuestionInput.value.trim();
    if (!question) {
        alert('Poll question is required');
        return;
    }
    
    const options = Array.from(pollOptionsContainer.children)
        .map(div => div.querySelector('input').value.trim())
        .filter(option => option.length > 0);
    
    if (options.length < 2) {
        alert('At least 2 options are required');
        return;
    }
    
    const allowMultiple = allowMultipleCheckbox.checked;
    const expiresAt = pollExpiresInput.value || null;
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        const pollMessage = {
            type: 'create_poll',
            group_id: currentGroup.id,
            poll_question: question,
            poll_options: options,
            poll_allow_multiple: allowMultiple,
            poll_expires_at: expiresAt,
            receiver_username: null,
            message: null,
            timestamp: null,
            message_id: null,
            emoji: null,
            poll_id: null,
            poll_option_ids: null
        };
        
        console.log('Sending poll creation message:', pollMessage);
        socket.send(JSON.stringify(pollMessage));
        
        createPollModal.style.display = 'none';
        resetPollForm();
        
        console.log('Poll creation message sent successfully');
    } else {
        alert('Connection error. Please try again.');
        console.error('WebSocket not connected. ReadyState:', socket ? socket.readyState : 'socket is null');
    }
}

function displayPollMessage(message, historical = false) {
    if (message.message && message.message.includes('📊 Poll')) {
        const existingMessage = document.querySelector(`[data-message-id="${message.id}"]`);
        if (existingMessage && message.id) {
            console.log('Duplicate poll message prevented (DOM check):', message.id);
            return;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${message.sender_username === currentUser ? 'sent' : 'received'} poll-message`;
        msgDiv.dataset.messageId = message.id;
        if (historical) msgDiv.classList.add('historical');

        const header = document.createElement('div');
        header.className = 'message-header';
        const displayNamePoll = (currentGroup && currentGroup.ghost_mode && message.group_id) ? 'Anonymous' : message.sender_username;
        header.textContent = `${displayNamePoll} • ${message.timestamp}`;

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = message.message;

        const pollButton = document.createElement('button');
        pollButton.className = 'poll-view-btn';
        pollButton.textContent = 'View Poll';
        pollButton.addEventListener('click', () => loadPollDetails(message.id));

        msgDiv.appendChild(header);
        msgDiv.appendChild(content);
        msgDiv.appendChild(pollButton);
        
        messagesDiv.appendChild(msgDiv);
        if (!historical) scrollToBottom();
    } else {
        displayMessage(message, historical);
    }
}

function loadPollDetails(pollId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'get_poll_details',
            poll_id: pollId
        }));
    }
}

function displayPollDetails(pollData) {
    const pollModal = document.createElement('div');
    pollModal.className = 'poll-modal';
    
    const totalVotes = pollData.total_votes || 0;
    
    pollModal.innerHTML = `
        <div class="poll-modal-content">
            <span class="close-poll-details">&times;</span>
            <h3>${pollData.question}</h3>
            <p>Created by: ${pollData.creator_username} at ${pollData.created_at}</p>
            ${pollData.allow_multiple_choices ? '<p><em>Multiple choices allowed</em></p>' : ''}
            <div class="poll-options">
                ${pollData.options.map(option => `
                    <div class="poll-option" data-option-id="${option.id}">
                        <label>
                            <input type="${pollData.allow_multiple_choices ? 'checkbox' : 'radio'}" 
                                   name="poll-vote" 
                                   value="${option.id}"
                                   ${option.voted_by_current_user ? 'checked' : ''}>
                            ${option.option_text}
                        </label>
                        <div class="vote-count">${option.vote_count} votes</div>
                        <div class="vote-bar">
                            <div class="vote-progress" style="width: ${totalVotes > 0 ? (option.vote_count / totalVotes * 100) : 0}%"></div>
                        </div>
                    </div>
                `).join('')}
            </div>
            <p>Total votes: ${totalVotes}</p>
            <button class="vote-poll-btn" onclick="submitVote(${pollData.id}, ${pollData.allow_multiple_choices})">Submit Vote</button>
        </div>
    `;
    
    document.body.appendChild(pollModal);
    pollModal.style.display = 'block';
    
    pollModal.querySelector('.close-poll-details').addEventListener('click', () => {
        pollModal.remove();
    });
    
    pollModal.addEventListener('click', (e) => {
        if (e.target === pollModal) {
            pollModal.remove();
        }
    });
}

function submitVote(pollId, allowMultiple) {
    const checkedInputs = document.querySelectorAll('input[name="poll-vote"]:checked');
    const optionIds = Array.from(checkedInputs).map(input => parseInt(input.value));
    
    if (optionIds.length === 0) {
        alert('Please select at least one option');
        return;
    }
    
    if (!allowMultiple && optionIds.length > 1) {
        alert('Only one option allowed');
        return;
    }
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'vote_poll',
            poll_id: pollId,
            poll_option_ids: optionIds
        }));
        
        const pollModal = document.querySelector('.poll-modal');
        if (pollModal) {
            pollModal.remove();
        }
    }
}

// ==========================
// Auth Functions
// ==========================
async function handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorDiv = document.getElementById('login-error');

    if (!username || !password) { showError(errorDiv, 'Please fill in all fields'); return; }

    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json();

        if (response.ok) {
            authToken = data.token;
            currentUser = username;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', currentUser);
            showMessengerInterface();
            loadContacts();
            loadGroups();
            loadNotes();
            showAIAssistant();
        } else {
            showError(errorDiv, data.error || 'Login failed');
        }
    } catch {
        showError(errorDiv, 'Network error. Please try again.');
    }
}

async function handleRegister() {
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const errorDiv = document.getElementById('register-error');

    if (!username || !password) { showError(errorDiv, 'Please fill in all fields'); return; }
    if (password.length < 6) { showError(errorDiv, 'Password must be at least 6 characters'); return; }

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json();

        if (response.ok) {
            document.getElementById('login-username').value = username;
            document.getElementById('login-password').value = password;
            showLoginForm();
            handleLogin();
        } else {
            showError(errorDiv, data.error || 'Registration failed');
        }
    } catch {
        showError(errorDiv, 'Network error. Please try again.');
    }
}

function handleLogout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    authToken = null;
    currentUser = null;
    currentConversation = null;
    currentGroup = null;

    if (socket) { socket.close(); socket = null; }

    showAuthInterface();
    clearMessages();
    clearContacts();
    clearGroups();
    hideAIAssistant();
}

// ==========================
// Contacts
// ==========================
async function loadContacts() {
    try {
        console.log('Loading contacts...');
        const response = await fetch('/users', { headers: { 'Authorization': `Bearer ${authToken}` } });
        console.log('Contacts response status:', response.status);
        
        if (response.ok) {
            const data = await response.json();
            console.log('Contacts data received:', data);
            contacts = data.users || [];
            console.log('Contacts array now contains:', contacts);
            displayContacts();
        } else {
            console.error('Failed to load contacts, status:', response.status);
            const errorText = await response.text();
            console.error('Contacts error response:', errorText);
        }
    } catch (err) { 
        console.error('Failed to load contacts:', err); 
    }
}

function displayContacts() {
    contactsList.innerHTML = '';
    const qEl = document.getElementById('contacts-search');
    const q = qEl ? qEl.value.trim().toLowerCase() : '';
    const list = q ? contacts.filter(u => (u||'').toLowerCase().includes(q)) : contacts;
    list.forEach(username => {
        const contactItem = document.createElement('div');
        contactItem.className = 'contact-item';

        // Randomly set online/offline for demo (in production, this would come from backend)
        const isOnline = Math.random() > 0.5;

        contactItem.innerHTML = `
            <div class="contact-info">
                <span class="user-status ${isOnline ? 'online' : 'offline'}"></span>
                <span class="contact-name">${username}</span>
            </div>
            <button class="contact-highlight-btn" title="Get chat highlights" onclick="event.stopPropagation(); generateChatHighlight('${username}', 'personal')">✨</button>
        `;

        contactItem.addEventListener('click', () => selectContact(username, contactItem));
        contactsList.appendChild(contactItem);
    });
}

async function selectContact(username, element) {
    console.log('Selecting contact:', username);
    // Ensure split UI is not interfering
    try {
        const area = document.querySelector('.chat-area');
        if (area) area.classList.remove('split');
        const sp2 = document.getElementById('split-pane-2'); if (sp2) sp2.style.display = 'none';
        const sph = document.getElementById('split-placeholder'); if (sph) sph.style.display = 'none';
        const mc1 = document.getElementById('messages-container');
        if (mc1) {
            mc1.style.transform = 'none';
            mc1.style.zoom = '1';
            mc1.style.scale = null;
            mc1.style.display = 'block';
            mc1.style.overflowY = 'auto';
        }
        const pinned = document.getElementById('pinned-messages-section');
        if (pinned) { pinned.style.position = 'static'; pinned.style.zIndex = 'auto'; }
    } catch {}
    
    document.querySelectorAll('.contact-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.group-item').forEach(item => item.classList.remove('active'));
    element.classList.add('active');

    currentConversation = username;
    currentGroup = null;
    chatWithUsername.textContent = username;
    chatHeader.style.display = 'block';
    welcomeScreen.style.display = 'none';
    messagesContainer.style.display = 'block';
    messageInputArea.style.display = 'block';
    messageInput.disabled = false;
    sendBtn.disabled = false;

    // Hide group menu for private chats but SHOW game buttons
    if (groupMenu) groupMenu.style.display = 'none';
    
    // Show DM lock button
    if (dmLockBtn) {
        dmLockBtn.style.display = 'inline-block';
        updateDMLockButton();
    }
    
    // Show game buttons for conversations
    const gameButtons = document.getElementById('game-buttons');
    if (gameButtons) {
        gameButtons.style.display = 'flex';
        console.log('Game buttons should now be visible for contact');
    }

    // Server-backed lock check
    const status = await fetchDMLockStatus(username);
    // If locked and not unlocked in this session, block and prompt
    if (status.locked && !isDMUnlocked(username)) {
        applyDMLockUI(username);
        clearMessages();
        messageInput.disabled = true;
        sendBtn.disabled = true;
        return;
    } else {
        removeDMLockUI();
        messageInput.disabled = false;
        sendBtn.disabled = false;
    }

    clearMessages();
    loadConversation(username);
    // Apply per-chat theme for DM
    try { await loadAndApplyThemeForCurrent(); } catch {}
}

// ==========================
// Groups
// ==========================
async function loadGroups() {
    try {
        console.log('Loading groups...');
        const response = await fetch('/groups', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        console.log('Groups response status:', response.status);
        
        if (response.ok) {
            const data = await response.json();
            console.log('Groups data received:', data);
            
            memberGroups = data.member_groups || [];
            availableGroups = data.available_groups || [];
            
            displayGroups();
        } else {
            console.error('Failed to load groups, status:', response.status);
            const errorText = await response.text();
            console.error('Groups error response:', errorText);
        }
    } catch (err) {
        console.error('Failed to load groups:', err);
    }
}

function displayGroups() {
    groupsList.innerHTML = '';
    if (availableGroupsList) availableGroupsList.innerHTML = '';
    const gqEl = document.getElementById('groups-search');
    const agqEl = document.getElementById('available-groups-search');
    const gq = gqEl ? gqEl.value.trim().toLowerCase() : '';
    const agq = agqEl ? agqEl.value.trim().toLowerCase() : '';
    const mg = gq ? memberGroups.filter(g => (g.name||'').toLowerCase().includes(gq)) : memberGroups;
    const ag = agq ? availableGroups.filter(g => (g.name||'').toLowerCase().includes(agq)) : availableGroups;

    mg.forEach(group => {
        const groupItem = document.createElement('div');
        groupItem.className = 'group-item';
        
        groupItem.innerHTML = `
            <div class="contact-info">
                <span class="contact-name">${group.name}</span>
            </div>
            <button class="contact-highlight-btn" title="Get group highlights" onclick="event.stopPropagation(); generateChatHighlight('${group.name}', 'group', ${group.id})">✨</button>
        `;
        
        groupItem.addEventListener('click', () => selectGroup(group, groupItem));
        groupsList.appendChild(groupItem);
    });

    if (availableGroupsList) {
        ag.forEach(group => {
            const groupItem = document.createElement('div');
            groupItem.className = 'available-group-item';
            
            const groupName = document.createElement('span');
            groupName.className = 'group-name';
            groupName.textContent = group.name;
            
            const joinBtn = document.createElement('button');
            joinBtn.className = 'join-group-btn';
            joinBtn.textContent = 'Join';
            joinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                joinGroup(group.id);
            });
            
            groupItem.appendChild(groupName);
            groupItem.appendChild(joinBtn);
            availableGroupsList.appendChild(groupItem);
        });
    }
}

function selectGroup(group, element) {
    console.log('Selecting group:', group.name);
    // Ensure split UI is not interfering
    try {
        const area = document.querySelector('.chat-area');
        if (area) area.classList.remove('split');
        const sp2 = document.getElementById('split-pane-2'); if (sp2) sp2.style.display = 'none';
        const sph = document.getElementById('split-placeholder'); if (sph) sph.style.display = 'none';
        const mc1 = document.getElementById('messages-container');
        if (mc1) {
            mc1.style.transform = 'none';
            mc1.style.zoom = '1';
            mc1.style.scale = null;
            mc1.style.display = 'block';
            mc1.style.overflowY = 'auto';
        }
        const pinned = document.getElementById('pinned-messages-section');
        if (pinned) { pinned.style.position = 'static'; pinned.style.zIndex = 'auto'; }
    } catch {}
    
    document.querySelectorAll('.contact-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.group-item').forEach(item => item.classList.remove('active'));
    element.classList.add('active');

    currentGroup = group;
    currentConversation = null;
    chatWithUsername.textContent = `Group: ${group.name}`;
    chatHeader.style.display = 'block';
    welcomeScreen.style.display = 'none';
    messagesContainer.style.display = 'block';
    messageInputArea.style.display = 'block';
    messageInput.disabled = false;
    sendBtn.disabled = false;

    // Show group menu for group chats AND game buttons
    if (groupMenu) groupMenu.style.display = 'block';
    if (dmLockBtn) dmLockBtn.style.display = 'none';
    removeDMLockUI();
    updateGhostToggleLabel();
    
    const gameButtons = document.getElementById('game-buttons');
    if (gameButtons) {
        gameButtons.style.display = 'flex';
        console.log('Game buttons should now be visible for group');
    }

    clearMessages();
    loadGroupConversation(group.id);
    // Apply per-chat theme for group
    (async () => { try { await loadAndApplyThemeForCurrent(); } catch {} })();
}
function updateGhostToggleLabel() {
    if (!toggleGhostBtn) return;
    const enabled = currentGroup && Boolean(currentGroup.ghost_mode);
    toggleGhostBtn.textContent = enabled ? '🙈 Disable Ghost Mode' : '👻 Enable Ghost Mode';
}

function loadGroupConversation(groupId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log('Requesting group conversation history for:', groupId);
        socket.send(JSON.stringify({ type: 'get_group_conversation', group_id: groupId }));
    }
}

async function joinGroup(groupId) {
    try {
        console.log(`Attempting to join group ${groupId}`);
        const response = await fetch('/groups/join', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ 
                group_id: groupId, 
                username: currentUser 
            })
        });
        
        const data = await response.json();
        console.log('Join group response:', data);
        
        if (response.ok) {
            if (data.status === 'joined') {
                alert('Successfully joined the group!');
                loadGroups();
            } else if (data.status === 'already_member') {
                alert('You are already a member of this group');
            } else {
                alert('Unexpected response: ' + data.status);
            }
        } else {
            alert('Failed to join group: ' + (data.error || 'Unknown error'));
        }
        
    } catch (err) {
        console.error('Error joining group:', err);
        alert('Failed to join group: ' + err.message);
    }
}

async function createGroup() {
    const name = groupNameInput.value.trim();
    const description = groupDescInput.value.trim();
    const members = groupMembersInput.value.split(',').map(u => u.trim()).filter(u => u);

    if (!name) { alert("Group name is required"); return; }

    console.log('Sending group creation request:', { name, description, members });

    try {
        const response = await fetch('/groups', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ name, description, members })
        });

        console.log('Response status:', response.status);
        
        const responseText = await response.text();
        console.log('Raw response:', responseText);

        if (!responseText) {
            console.error('Empty response from server');
            alert('Server returned empty response');
            return;
        }

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (jsonError) {
            console.error('JSON parsing error:', jsonError);
            alert('Server returned invalid response: ' + responseText.substring(0, 100));
            return;
        }

        if (response.ok) {
            console.log('Group created successfully:', data);
            loadGroups();
            groupNameInput.value = '';
            groupDescInput.value = '';
            groupMembersInput.value = '';
            createGroupModal.style.display = 'none';
        } else {
            console.error('Group creation failed:', data);
            alert(data.error || "Failed to create group");
        }
    } catch (err) {
        console.error("Network error creating group:", err);
        alert("Network error creating group: " + err.message);
    }
}

// ==========================
// Group Management Functions
// ==========================
async function showGroupMembers() {
    if (!currentGroup) return;
    
    try {
        membersList.innerHTML = '';
        
        if (currentGroup.members && currentGroup.members.length > 0) {
            currentGroup.members.forEach(member => {
                const memberDiv = document.createElement('div');
                memberDiv.style.padding = '10px';
                memberDiv.style.borderBottom = '1px solid #eee';
                memberDiv.textContent = member;
                membersList.appendChild(memberDiv);
            });
        } else {
            membersList.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No members found</div>';
        }
        
        viewMembersModal.style.display = 'block';
    } catch (err) {
        console.error('Error showing group members:', err);
        alert('Failed to load group members');
    }
}

async function addMembersToGroup() {
    if (!currentGroup) {
        alert('No group selected');
        return;
    }
    
    const newMembers = newMembersInput.value.split(',').map(u => u.trim()).filter(u => u);
    
    if (newMembers.length === 0) {
        alert('Please enter at least one username');
        return;
    }
    
    try {
        let successCount = 0;
        let errorCount = 0;
        
        for (const username of newMembers) {
            console.log(`Adding user: ${username}`);
            const response = await fetch('/groups/join', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${authToken}`
                },
                body: JSON.stringify({ 
                    group_id: currentGroup.id, 
                    username: username 
                })
            });
            
            if (response.ok) {
                successCount++;
                console.log(`Successfully added ${username}`);
            } else {
                errorCount++;
                console.error(`Failed to add member ${username}`, await response.text());
            }
        }
        
        if (successCount > 0 && errorCount === 0) {
            alert(`Successfully added ${successCount} member(s) to the group`);
        } else if (successCount > 0 && errorCount > 0) {
            alert(`Added ${successCount} member(s) successfully, but failed to add ${errorCount} member(s)`);
        } else {
            alert('Failed to add any members');
            return;
        }
        
        newMembersInput.value = '';
        addMembersModal.style.display = 'none';
        await loadGroups();
        
    } catch (err) {
        console.error('Error adding members:', err);
        alert('Failed to add members: ' + err.message);
    }
}

async function editGroup() {
    if (!currentGroup) return;
    
    const newName = prompt('Enter new group name:', currentGroup.name);
    if (!newName || newName.trim() === '') return;
    
    const newDescription = prompt('Enter new description:', currentGroup.description || '');
    
    try {
        const response = await fetch('/groups/update', {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ 
                group_id: currentGroup.id,
                name: newName.trim(),
                description: newDescription ? newDescription.trim() : null
            })
        });
        
        if (response.ok) {
            alert('Group updated successfully');
            loadGroups();
            chatWithUsername.textContent = `Group: ${newName.trim()}`;
        } else {
            const errorData = await response.json();
            alert('Failed to update group: ' + (errorData.error || 'Unknown error'));
        }
        
    } catch (err) {
        console.error('Error updating group:', err);
        alert('Failed to update group: ' + err.message);
    }
}

async function leaveGroup() {
    if (!currentGroup) return;
    
    if (!confirm(`Are you sure you want to leave "${currentGroup.name}"?`)) {
        return;
    }
    
    try {
        const response = await fetch('/groups/leave', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ 
                group_id: currentGroup.id, 
                username: currentUser 
            })
        });
        
        if (response.ok) {
            alert('Left group successfully');
            
            currentGroup = null;
            chatHeader.style.display = 'none';
            welcomeScreen.style.display = 'block';
            messagesContainer.style.display = 'none';
            messageInputArea.style.display = 'none';
            
            loadGroups();
        } else {
            const errorData = await response.json();
            alert('Failed to leave group: ' + (errorData.error || 'Unknown error'));
        }
        
    } catch (err) {
        console.error('Error leaving group:', err);
        alert('Failed to leave group: ' + err.message);
    }
}

// ==========================
// WebSocket & Messaging
// ==========================
function connectWebSocket() {
    if (socket) socket.close();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws?token=${authToken}`;
    socket = new WebSocket(wsUrl);

    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
        console.log('Connected to server');

        // Re-request reactions for all visible messages after (re)connect
        try {
            const msgs = document.querySelectorAll('.message[data-message-id]');
            msgs.forEach(el => {
                const mid = Number(el.dataset.messageId);
                if (mid && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'get_reactions',
                        message_id: mid
                    }));
                }
            });

            // Also refresh pinned messages on reconnect
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'get_pinned_messages' }));
            }
        } catch (e) {
            console.warn('Failed to re-request reactions after connect:', e);
        }
    };

    socket.onmessage = async (event) => {
        try {
            if (typeof event.data === 'string') {
                let data = JSON.parse(event.data);
                console.log('Received WebSocket message:', data);
                
                // Check if data.message contains a JSON string (for system messages)
                if (data.sender_username === 'system' && typeof data.message === 'string' && data.message.startsWith('{')) {
                    try {
                        const nestedData = JSON.parse(data.message);
                        console.log('Parsed nested system message:', nestedData);
                        data = nestedData;
                    } catch (e) {
                        console.log('Failed to parse nested message, using original data');
                    }
                }
                
                // Handle WebRTC signaling first
                if (data.type === 'call_offer' && data.to === currentUser) {
                    try {
                        currentCallPeer = data.from;
                        await ensureMedia();
                        await ensurePeerConnection();
                        openCallModal();
                        const desc = JSON.parse(data.sdp);
                        await pc.setRemoteDescription(desc);
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        socket.send(JSON.stringify({ type: 'call_answer', target_username: currentCallPeer, sdp: JSON.stringify(answer) }));
                    } catch (e) { console.error('Offer handling failed', e); }
                    return;
                } else if (data.type === 'call_answer' && data.to === currentUser) {
                    try {
                        const desc = JSON.parse(data.sdp);
                        if (pc && pc.signalingState === 'have-local-offer') {
                            await pc.setRemoteDescription(desc);
                        } else {
                            console.warn('Ignoring late/duplicate answer in state', pc ? pc.signalingState : 'no-pc');
                        }
                    } catch (e) { console.error('Answer handling failed', e); }
                    return;
                } else if (data.type === 'call_ice' && data.to === currentUser) {
                    try {
                        if (!data.candidate) return;
                        const cand = JSON.parse(data.candidate);
                        if (!pc) {
                            await ensureMedia();
                            await ensurePeerConnection();
                            openCallModal();
                        }
                        if (!pc.remoteDescription) {
                            pendingIceCandidates.push(cand);
                            // Ask caller to resend offer if we haven't received it yet
                            if (data.from && !offerRequestedFrom.has(data.from)) {
                                offerRequestedFrom.add(data.from);
                                socket.send(JSON.stringify({ type: 'call_need_offer', target_username: data.from }));
                            }
                        } else {
                            await pc.addIceCandidate(cand);
                        }
                    } catch (e) { console.error('ICE handling failed', e); }
                    return;
                } else if (data.type === 'call_end' && data.to === currentUser) {
                    endCall(false);
                    return;
                } else if (data.type === 'call_need_offer' && data.to === currentUser) {
                    // Peer requests we resend an offer
                    try {
                        currentCallPeer = data.from;
                        await ensureMedia();
                        await ensurePeerConnection();
                        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
                        await pc.setLocalDescription(offer);
                        socket.send(JSON.stringify({ type: 'call_offer', target_username: currentCallPeer, sdp: JSON.stringify(offer) }));
                    } catch (e) { console.error('Resend offer failed', e); }
                    return;
                }

                // Handle game-specific messages next
                if (data.type === 'game_state' || data.type === 'game_update' || data.type === 'game_created' || data.type === 'game_joined') {
                    handleGameWebSocketMessage(data);
                } else if (data.type === 'game_error') {
                    console.error('Game error:', data.error);
                    alert('Game error: ' + data.error);
                    
                    // Re-enable trivia options if this was a trivia game error
                    const options = gameBoard ? gameBoard.querySelectorAll('.trivia-option') : [];
                    if (options.length > 0) {
                        options.forEach(option => {
                            option.disabled = false;
                            option.style.opacity = '1';
                            option.style.cursor = 'pointer';
                        });
                        
                        // Reset the answer prompt
                        const answerPrompt = gameBoard.querySelector('.answer-prompt');
                        if (answerPrompt) {
                            answerPrompt.innerHTML = 'Choose your answer:';
                        }
                    }
                } else if (data.message && data.message.includes('🎮') && data.message.includes('made a move')) {
                    // This is a move notification message - request updated game state
                    console.log('Move notification received, requesting game state update');
                    displayGameMessage(data);
                    
                    // Extract game ID and request current game state
                    const gameId = extractGameId(data.message);
                    if (gameId && socket && socket.readyState === WebSocket.OPEN) {
                        console.log('Requesting updated game state for game ID:', gameId);
                        socket.send(JSON.stringify({
                            type: 'get_game_state',
                            game_id: gameId
                        }));
                    }
                } else if (data.message && data.message.includes('🎮')) {
                    // Other game messages (like game created)
                    displayGameMessage(data);
                } else if (data.type === 'conversation_history') {
                    // Route to pane 2 if this history was requested for pane2
                    if (pane2ExpectedHistory && data.conversation_with === pane2ExpectedHistory) {
                        if (messagesDiv2) messagesDiv2.innerHTML = '';
                        if (data.messages && data.messages.length > 0 && messagesDiv2) {
                            data.messages.forEach(msg => {
                                const div = document.createElement('div');
                                div.className = 'message ' + (msg.sender_username === currentUser ? 'sent' : 'received');
                                const header = document.createElement('div'); header.className='message-header'; header.textContent = `${msg.sender_username} • ${msg.timestamp}`;
                                const body = document.createElement('div'); body.className='message-content'; body.textContent = msg.message;
                                div.appendChild(header); div.appendChild(body);
                                messagesDiv2.appendChild(div);
                            });
                        }
                        pane2ExpectedHistory = null;
                    } else {
                        displayConversationHistory(data);
                    }
                } else if (data.type === 'group_conversation_history') {
                    displayConversationHistory(data);
                } else if (data.type === 'poll_details') {
                    displayPollDetails(data.poll);
                } else if (data.type === 'call_offer' && data.to === currentUser) {
                    try {
                        await ensureMedia();
                        await ensurePeerConnection();
                        openCallModal();
                        const desc = JSON.parse(data.sdp);
                        await pc.setRemoteDescription(desc);
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        socket.send(JSON.stringify({
                            type: 'call_answer',
                            target_username: data.from,
                            sdp: JSON.stringify(answer)
                        }));
                    } catch (e) { console.error('Offer handling failed', e); }
                } else if (data.type === 'call_answer' && data.to === currentUser) {
                    try {
                        const desc = JSON.parse(data.sdp);
                        await pc.setRemoteDescription(desc);
                    } catch (e) { console.error('Answer handling failed', e); }
                } else if (data.type === 'call_ice' && data.to === currentUser) {
                    try {
                        if (!data.candidate) return;
                        const cand = JSON.parse(data.candidate);
                        if (!pc) {
                            // Queue until pc is ready
                            pendingIceCandidates.push(cand);
                        } else if (!pc.remoteDescription) {
                            // In some cases ICE can arrive before remoteDescription is set
                            pendingIceCandidates.push(cand);
                        } else {
                            await pc.addIceCandidate(cand);
                        }
                    } catch (e) { console.error('ICE handling failed', e); }
                } else if (data.type === 'call_end' && data.to === currentUser) {
                    endCall(false);
                } else if (data.sender_username && data.receiver_username && isMessageForCurrentConversation(data)) {
                    displayMessage(data);
                } else if (data.sender_username && data.receiver_username && currentConversation2 && (
                    (data.sender_username === currentUser && data.receiver_username === currentConversation2) ||
                    (data.sender_username === currentConversation2 && data.receiver_username === currentUser)
                )) {
                    if (messagesDiv2) {
                        const div = document.createElement('div');
                        div.className = 'message ' + (data.sender_username === currentUser ? 'sent' : 'received');
                        const header = document.createElement('div'); header.className='message-header'; header.textContent = `${data.sender_username} • ${data.timestamp}`;
                        const body = document.createElement('div'); body.className='message-content'; body.textContent = data.message;
                        div.appendChild(header); div.appendChild(body);
                        messagesDiv2.appendChild(div);
                        const mc2 = document.getElementById('messages-container-2');
                        if (mc2) mc2.scrollTop = mc2.scrollHeight;
                    }
                } else if (data.group_id && currentGroup && data.group_id === currentGroup.id) {
                    console.log('Displaying group message for current group:', data);
                    if (data.message && data.message.includes('📊 Poll')) {
                        console.log('This is a poll message, displaying with poll styling');
                        displayPollMessage(data);
                    } else {
                        console.log('This is a regular group message');
                        displayMessage(data);
                    }
                } else if (data.group_id) {
                    console.log('Received message for different group:', data.group_id, 'current group:', currentGroup ? currentGroup.id : 'none');
                } else if (data.type === 'file_ready' && pendingFile) {
                    const arrayBuffer = await pendingFile.arrayBuffer();
                    socket.send(arrayBuffer);
                    pendingFile = null;
                } else if (data.type === 'reaction_added') {
                    console.log('DEBUG: Received reaction_added message:', data);
                    handleReactionAdded(data);
                } else if (data.type === 'reaction_removed') {
                    handleReactionRemoved(data);
                } else if (data.type === 'message_pinned') {
                    handleMessagePinned(data);
                } else if (data.type === 'message_unpinned') {
                    handleMessageUnpinned(data);
                } else if (data.type === 'reactions_list') {
                    // If message element isn't rendered yet, stash and apply later
                    const msgDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
                    if (!msgDiv) {
                        pendingReactions.set(data.message_id, data.reactions || {});
                    } else {
                    handleReactionsList(data);
                    }
                } else if (data.type === 'pinned_messages_list') {
                    handlePinnedMessagesList(data);
                } else if (data.type === 'message_edited') {
                    const m = document.querySelector(`[data-message-id="${data.message_id}"]`);
                    if (m) {
                        const c = m.querySelector('.message-content');
                        if (c) { c.textContent = `${data.message} (edited)`; }
                    }
                } else if (data.type === 'message_deleted') {
                    const m = document.querySelector(`[data-message-id="${data.message_id}"]`);
                    if (m) {
                        const c = m.querySelector('.message-content');
                        if (c) { c.textContent = 'Message recalled by sender'; }
                        // Mark as deleted and hide edit/delete buttons
                        m.classList.add('deleted-message');
                        const editBtn = m.querySelector('.message-action-btn[title="Edit message"]');
                        const delBtn = m.querySelector('.message-action-btn[title="Delete message"]');
                        if (editBtn) editBtn.remove();
                        if (delBtn) delBtn.remove();
                    }
                } else if (data.type === 'schedule_ack') {
                    if (data.ok) {
                        showNotification('Message scheduled ✅', 'success');
                        const m = document.getElementById('schedule-modal');
                        if (m) m.style.display = 'none';
                    } else {
                        showNotification('Failed to schedule: ' + (data.error || 'Unknown'), 'error');
                    }
                } else {
                    console.log('Message not handled:', data);
                }
            } else {
                console.log('Binary message received (not displayed in UI)');
            }
        } catch (err) {
            console.error('Error parsing WebSocket message:', err);
        }
    };

    socket.onclose = () => setTimeout(() => { if (authToken) connectWebSocket(); }, 3000);
    socket.onerror = (err) => console.error('WebSocket error:', err);
}

function isMessageForCurrentConversation(message) {
    if (!currentConversation) return false;
    return (message.sender_username === currentUser && message.receiver_username === currentConversation) ||
           (message.sender_username === currentConversation && message.receiver_username === currentUser);
}

function loadConversation(username) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log('Requesting conversation history for:', username);
        socket.send(JSON.stringify({ type: 'get_conversation', receiver_username: username }));
    }
}

function displayConversationHistory(data) {
    if (data.conversation_with) {
        if (data.conversation_with !== currentConversation) {
            console.log('History for different conversation, ignoring');
            return;
        }
    }

    if (data.group_id) {
        if (!currentGroup || data.group_id !== currentGroup.id) {
            console.log('History for different group, ignoring');
            return;
        }
    }

    console.log('Displaying conversation history:', data);
    clearMessages();

    // Clear allMessages when switching conversations
    allMessages = [];

    if (data.messages && data.messages.length > 0) {
        addHistorySeparator('--- Conversation History ---');
        data.messages.forEach(msg => {
            if (msg.message && msg.message.includes('🎮')) {
                displayGameMessage(msg, true);
            } else if (msg.message && msg.message.includes('📊 Poll')) {
                displayPollMessage(msg, true);
            } else {
                displayMessage(msg, true);
            }
        });
        addHistorySeparator('--- End of History ---');
        if (pendingGhostNotice && currentGroup) {
            // Back-compat: record and clear
            recordGhostBanner(currentGroup.id, pendingGhostNotice);
            pendingGhostNotice = null;
        }
        renderGhostBannersForCurrentGroup();
        console.log(`Displayed ${data.messages.length} historical messages`);
    } else {
        console.log('No messages in history');
    }

    // Load pinned messages for this conversation
    loadPinnedMessages();

    scrollToBottom();

    // After rendering history, request reactions for all messages to hydrate counts
    try {
        const msgs = document.querySelectorAll('.message[data-message-id]');
        msgs.forEach(el => {
            const mid = Number(el.dataset.messageId);
            if (mid && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'get_reactions',
                    message_id: mid
                }));
            }
        });
    } catch (e) {
        console.warn('Failed to request reactions after history render:', e);
    }
}

function addHistorySeparator(text) {
    const sep = document.createElement('div');
    sep.className = 'history-separator';
    sep.textContent = text;
    messagesDiv.appendChild(sep);
}

function displayMessage(message, historical = false) {
    const existingMessage = document.querySelector(`[data-message-id="${message.id}"]`);
    if (existingMessage && message.id) {
        console.log('Duplicate message prevented (DOM check):', message.id);
        return;
    }

    // Store message for search
    if (!allMessages.some(m => m.id === message.id)) {
        allMessages.push(message);
    }

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${message.sender_username === currentUser ? 'sent' : 'received'}`;
    msgDiv.dataset.messageId = message.id;
    if (historical) msgDiv.classList.add('historical');

    const header = document.createElement('div');
    header.className = 'message-header';
    const displayName = (currentGroup && currentGroup.ghost_mode && message.group_id) ? 'Anonymous' : message.sender_username;
    header.textContent = `${displayName} • ${message.timestamp}`;

    const content = document.createElement('div');
    content.className = 'message-content';

    // Check if message is deleted
    const isDeleted = message.deleted || message.message === 'Message recalled by sender';

    if (message.file_url) {
        const img = document.createElement('img');
        img.src = message.file_url;
        img.style.maxWidth = '200px';
        img.style.maxHeight = '200px';
        img.style.display = 'block';
        content.appendChild(img);
    } else {
        content.textContent = message.message;
    }

    // Mark deleted messages
    if (isDeleted) {
        msgDiv.classList.add('deleted-message');
    }

    // Handle delayed reveal
    if (message.reveal_at) {
        const revealTime = parseISOToMs(message.reveal_at);
        if (!isNaN(revealTime)) {
            const now = Date.now();
            if (revealTime > now) {
                content.classList.add('blurred');
                // Add cosmic overlay
                const overlay = document.createElement('div');
                overlay.className = 'reveal-overlay cosmic';
                const sheen = document.createElement('div');
                sheen.className = 'cosmic-sheen';
                overlay.appendChild(sheen);
                for (let i = 0; i < 8; i++) {
                    const dot = document.createElement('span');
                    dot.className = 'cosmic-dot';
                    // scatter initial positions roughly
                    dot.style.left = Math.floor(Math.random()*80+10) + '%';
                    dot.style.top = Math.floor(Math.random()*80+10) + '%';
                    overlay.appendChild(dot);
                }
                content.appendChild(overlay);
                const delay = revealTime - now;
                setTimeout(() => {
                    content.classList.remove('blurred');
                    const ov = content.querySelector('.reveal-overlay');
                    if (ov) ov.remove();
                }, delay);
            }
        }
    } else if (message.sender_username === currentUser && pendingRevealISO) {
        const revealTime = parseISOToMs(pendingRevealISO);
        if (!isNaN(revealTime)) {
            const now = Date.now();
            if (revealTime > now) {
                content.classList.add('blurred');
                const overlay = document.createElement('div');
                overlay.className = 'reveal-overlay cosmic';
                const sheen = document.createElement('div');
                sheen.className = 'cosmic-sheen';
                overlay.appendChild(sheen);
                for (let i = 0; i < 8; i++) {
                    const dot = document.createElement('span');
                    dot.className = 'cosmic-dot';
                    dot.style.left = Math.floor(Math.random()*80+10) + '%';
                    dot.style.top = Math.floor(Math.random()*80+10) + '%';
                    overlay.appendChild(dot);
                }
                content.appendChild(overlay);
                setTimeout(() => {
                    content.classList.remove('blurred');
                    const ov = content.querySelector('.reveal-overlay');
                    if (ov) ov.remove();
                }, revealTime - now);
            }
        }
        pendingRevealISO = null;
    }

    const reactionsDiv = document.createElement('div');
    reactionsDiv.className = 'message-reactions';
    // Apply reactions from payload (history path)
    if (message.reactions && Object.keys(message.reactions).length > 0) {
        for (const emoji in message.reactions) {
            const span = document.createElement('span');
            span.className = 'reaction-emoji';
            span.dataset.emoji = emoji;
            
            const users = message.reactions[emoji];
            let count = 1;
            let userList = [];
            
            if (Array.isArray(users)) {
                count = users.length;
                userList = users;
            } else if (typeof users === 'object' && users !== null) {
                count = Object.keys(users).length;
                userList = Object.keys(users);
            } else if (typeof users === 'number') {
                count = users;
            }
            
            span.innerHTML = `${emoji} <span class="reaction-count">${count}</span>`;
            span.title = userList.length > 0 ? `Reacted by: ${userList.join(', ')}` : `${count} reaction${count !== 1 ? 's' : ''}`;
            reactionsDiv.appendChild(span);
        }
    }

    // Apply any reactions that arrived before the element existed
    try {
        const cached = pendingReactions.get(message.id);
        if (cached && Object.keys(cached).length > 0) {
            let reactionsDivLocal = reactionsDiv;
            if (!reactionsDivLocal) {
                reactionsDivLocal = document.createElement('div');
                reactionsDivLocal.className = 'message-reactions';
                const actionsDivLocal = msgDiv.querySelector('.message-actions');
                if (actionsDivLocal) {
                    msgDiv.insertBefore(reactionsDivLocal, actionsDivLocal);
                } else {
                    msgDiv.appendChild(reactionsDivLocal);
                }
            }
            for (const [emoji, users] of Object.entries(cached)) {
                const span = document.createElement('span');
                span.className = 'reaction-emoji';
                span.dataset.emoji = emoji;
                const count = Array.isArray(users) ? users.length : (typeof users === 'number' ? users : Object.keys(users || {}).length || 1);
                span.innerHTML = `${emoji} <span class="reaction-count">${count}</span>`;
                reactionsDivLocal.appendChild(span);
            }
            pendingReactions.delete(message.id);
        }
    } catch (e) {
        console.warn('Failed to apply pending reactions:', e);
    }

    // Message actions menu
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'message-action-btn';
    pinBtn.textContent = '📌';
    pinBtn.title = 'Pin/Unpin message';
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinMessage(msgDiv, message.id, pinBtn);
    });

    const reactionBtn = document.createElement('button');
    reactionBtn.className = 'message-action-btn';
    reactionBtn.textContent = '😊';
    reactionBtn.title = 'React to message';
    reactionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showReactionPicker(msgDiv, message.id);
    });

    actionsDiv.appendChild(pinBtn);
    actionsDiv.appendChild(reactionBtn);

    // Edit/Delete only for own messages (and not deleted)
    if (message.sender_username === currentUser && !isDeleted) {
        const editBtn = document.createElement('button');
        editBtn.className = 'message-action-btn';
        editBtn.textContent = '✏️';
        editBtn.title = 'Edit message';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentText = content.textContent || '';
            const newText = prompt('Edit message:', currentText);
            if (newText !== null && newText.trim() && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'edit_message', message_id: message.id, message: newText.trim() }));
            }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'message-action-btn';
        delBtn.textContent = '🗑️';
        delBtn.title = 'Delete message';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Recall this message?')) {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'delete_message', message_id: message.id }));
                }
            }
        });

        actionsDiv.appendChild(editBtn);
        actionsDiv.appendChild(delBtn);
    }

    msgDiv.appendChild(header);
    msgDiv.appendChild(content);
    msgDiv.appendChild(reactionsDiv);
    msgDiv.appendChild(actionsDiv);

    // Debug: Log that we added action buttons
    console.log('Message created with action buttons:', {
        messageId: message.id,
        hasActions: !!actionsDiv,
        actionButtons: actionsDiv.children.length
    });

    messagesDiv.appendChild(msgDiv);
    if (!historical) scrollToBottom();

    // Load reactions and pin status for this message
    if (message.id) {
        loadReactionsForMessage(message.id);
    }
}

function togglePinMessage(msgDiv, messageId, pinBtn) {
    const wasPinned = msgDiv.classList.contains('pinned');

    if (socket && socket.readyState === WebSocket.OPEN) {
        if (wasPinned) {
            socket.send(JSON.stringify({
                type: 'unpin_message',
                message_id: messageId
            }));
        } else {
            socket.send(JSON.stringify({
                type: 'pin_message',
                message_id: messageId
            }));
        }
    }
}

async function searchMessages(query) {
    if (!query || query.trim().length === 0) {
        searchResults.style.display = 'none';
        return;
    }
    try {
        const res = await fetch(`/search_messages?q=${encodeURIComponent(query)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) { searchResults.style.display = 'none'; return; }
        const data = await res.json();
        const results = Array.isArray(data.results) ? data.results : [];
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="no-search-results">No messages found</div>';
        searchResults.style.display = 'block';
        return;
    }
    searchResults.innerHTML = '';
        results.slice(0, 20).forEach(row => {
        const resultItem = document.createElement('div');
        resultItem.className = 'search-result-item';
            const meta = row.type === 'group' ? `Group #${row.group_id}` : `${row.sender} → ${row.receiver}`;
        resultItem.innerHTML = `
                <div class="search-result-user">${meta}</div>
                <div class="search-result-message">${row.message}</div>
                <div class="search-result-time">${row.timestamp}</div>
            `;
        resultItem.addEventListener('click', () => {
                // Optional: jump to chat - for now just close results
            searchResults.style.display = 'none';
            searchInput.value = '';
        });
        searchResults.appendChild(resultItem);
    });
    searchResults.style.display = 'block';
    } catch {
        searchResults.style.display = 'none';
    }
}

function highlightMessage(messageId) {
    const msgElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (msgElement) {
        msgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgElement.style.background = '#fff3cd';
        setTimeout(() => {
            msgElement.style.background = '';
        }, 2000);
    }
}

function showTypingIndicator(username) {
    const existingIndicator = document.getElementById('typing-indicator');
    if (existingIndicator) return;

    const indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'typing-indicator';
    indicator.innerHTML = `
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
    `;

    messagesDiv.appendChild(indicator);
    scrollToBottom();
}

function hideTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}

function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

    if (currentConversation) {
        const msg = { type: 'chat_message', receiver_username: currentConversation, message: text, timestamp: getCurrentTime() };
        if (revealAtISO) { msg.reveal_at = revealAtISO; pendingRevealISO = revealAtISO; }
        socket.send(JSON.stringify(msg));
    } else if (currentGroup) {
        const msg = { type: 'group_message', group_id: currentGroup.id, message: text, timestamp: getCurrentTime() };
        if (revealAtISO) { msg.reveal_at = revealAtISO; pendingRevealISO = revealAtISO; }
        socket.send(JSON.stringify(msg));
    }

    messageInput.value = '';
    revealAtISO = null;
}

// ==== Call UI wiring ====
document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'call-btn') {
        startCall();
    } else if (t.id === 'close-call-modal' || t.id === 'call-end-btn') {
        endCall(true);
    } else if (t.id === 'schedule-btn') {
        const m = document.getElementById('schedule-modal');
        if (m) m.style.display = 'block';
    } else if (t.id === 'close-schedule-modal') {
        const m = document.getElementById('schedule-modal');
        if (m) m.style.display = 'none';
    } else if (t.id === 'schedule-submit') {
        const dt = document.getElementById('schedule-datetime');
        const txt = document.getElementById('schedule-text');
        if (!dt || !txt) return;
        const when = dt.value;
        const message = txt.value.trim();
        if (!when || !message) { showNotification('Pick time and enter message', 'error'); return; }
        if (!socket || socket.readyState !== WebSocket.OPEN) { showNotification('Not connected', 'error'); return; }
        // Build payload
        const localDate = new Date(when);
        const payload = { type: 'schedule_message', message, scheduled_at: localDate.toISOString(), scheduled_at_epoch: Math.floor(localDate.getTime()/1000) };
        if (currentConversation) payload.receiver_username = currentConversation;
        if (currentGroup) payload.group_id = currentGroup.id;
        socket.send(JSON.stringify(payload));
    } else if (t.id === 'blur-btn') {
        const m = document.getElementById('reveal-modal');
        if (m) m.style.display = 'block';
    } else if (t.id === 'close-reveal-modal') {
        const m = document.getElementById('reveal-modal');
        if (m) m.style.display = 'none';
    } else if (t.id === 'reveal-apply') {
        const inp = document.getElementById('reveal-datetime');
        if (!inp || !inp.value) { showNotification('Pick a reveal time', 'error'); return; }
        const d = new Date(inp.value);
        if (isNaN(d.getTime())) { showNotification('Invalid time', 'error'); return; }
        revealAtISO = d.toISOString();
        const m = document.getElementById('reveal-modal'); if (m) m.style.display = 'none';
        showNotification('Reveal time set for next message', 'info');
    } else if (t.id === 'add-note-btn') {
        openNoteModal();
        setCurrentNote(null);
    } else if (t.id === 'close-note-modal') {
        closeNoteModal();
    } else if (t.id === 'save-note-btn') {
        saveCurrentNote();
    } else if (t.id === 'delete-note-btn') {
        deleteCurrentNote();
    }
});

// ===== Notes Client Logic =====
let currentNoteId = null;
function setCurrentNote(id) { currentNoteId = id; }
function openNoteModal(note) {
    const m = document.getElementById('note-modal');
    if (!m) return;
    m.style.display = 'block';
    const title = document.getElementById('note-title');
    const content = document.getElementById('note-content');
    if (note) {
        setCurrentNote(note.id);
        title.value = note.title || '';
        content.value = note.content || '';
    } else {
        setCurrentNote(null);
        title.value = '';
        content.value = '';
    }
}
function closeNoteModal() {
    const m = document.getElementById('note-modal');
    if (m) m.style.display = 'none';
}
async function loadNotes() {
    try {
        const res = await fetch('/notes', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const data = await res.json();
        window.notesData = data.notes || [];
        displayNotes();
    } catch {}
}
async function saveCurrentNote() {
    const title = document.getElementById('note-title').value;
    const content = document.getElementById('note-content').value;
    if (!content.trim()) { showNotification('Content required', 'error'); return; }
    try {
        if (currentNoteId) {
            await fetch(`/notes/${currentNoteId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ id: currentNoteId, title, content })
            });
        } else {
            await fetch('/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ title, content })
            });
        }
        closeNoteModal();
        loadNotes();
    } catch {}
}
async function deleteCurrentNote() {
    if (!currentNoteId) { closeNoteModal(); return; }
    try {
        await fetch(`/notes/${currentNoteId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
        closeNoteModal();
        loadNotes();
    } catch {}
}

function displayNotes() {
    const list = document.getElementById('notes-list');
    if (!list) return;
    const qEl = document.getElementById('notes-search');
    const q = qEl ? qEl.value.trim().toLowerCase() : '';
    const src = Array.isArray(window.notesData) ? window.notesData : [];
    const filtered = q ? src.filter(n => ((n.title||'') + ' ' + (n.content||'')).toLowerCase().includes(q)) : src;
    list.innerHTML = '';
    filtered.forEach(n => {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.noteId = n.id;
        div.textContent = (n.title && n.title.trim()) ? n.title : (n.content || '').slice(0,40) || 'Untitled';
        div.addEventListener('click', () => openNoteModal(n));
        list.appendChild(div);
    });
}

// Load notes after login
// If you have a login success path, call loadNotes() there.

function sendImage() {
    const file = imageInput.files[0];
    if (!file || !socket || socket.readyState !== WebSocket.OPEN) return;

    pendingFile = file;

    const metaMessage = {
        type: 'file_meta',
        message: file.name
    };

    if (currentConversation) metaMessage.receiver_username = currentConversation;
    else if (currentGroup) metaMessage.group_id = currentGroup.id;

    socket.send(JSON.stringify(metaMessage));

    imageInput.value = '';

    const fakeUrl = URL.createObjectURL(file);
    displayMessage({
        id: Date.now(),
        sender_username: currentUser,
        receiver_username: currentConversation || null,
        group_id: currentGroup ? currentGroup.id : null,
        message: '',
        file_url: fakeUrl,
        timestamp: getCurrentTime()
    });
}

function showReactionPicker(messageDiv, messageId) {
    clearTimeout(reactionPickerTimeout);
    const existingPicker = document.querySelector('.reaction-picker');
    if (existingPicker) existingPicker.remove();

    const picker = document.createElement('div');
    picker.className = 'reaction-picker show';
    picker.innerHTML = `
        <span class="emoji" data-emoji="👍">👍</span>
        <span class="emoji" data-emoji="❤️">❤️</span>
        <span class="emoji" data-emoji="😂">😂</span>
        <span class="emoji" data-emoji="😢">😢</span>
        <span class="emoji" data-emoji="😡">😡</span>
    `;

    // Add to body instead of message div
    document.body.appendChild(picker);

    // Position picker near the message but fixed to viewport
    const rect = messageDiv.getBoundingClientRect();
    const pickerHeight = 50; // Approximate height
    const pickerWidth = 250; // Approximate width

    // Position above the message if there's space, otherwise below
    let top = rect.top - pickerHeight - 10;
    if (top < 0) {
        top = rect.bottom + 10;
    }

    // Keep within viewport horizontally
    let left = rect.left;
    if (left + pickerWidth > window.innerWidth) {
        left = window.innerWidth - pickerWidth - 10;
    }
    if (left < 10) {
        left = 10;
    }

    picker.style.top = `${top}px`;
    picker.style.left = `${left}px`;

    picker.addEventListener('click', (e) => {
        if (e.target.classList.contains('emoji')) {
            sendReaction(messageId, e.target.dataset.emoji);
            picker.remove();
        }
    });

    // Close picker when clicking outside
    setTimeout(() => {
        const closeHandler = (e) => {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 100);
}

function hideReactionPicker() {
    reactionPickerTimeout = setTimeout(() => {
        const picker = document.querySelector('.reaction-picker');
        if (picker) picker.remove();
    }, 2000);
}

function sendReaction(messageId, emoji) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'add_reaction',
            message_id: messageId,
            emoji: emoji
        }));
    }
}

function handleReactionAdded(data) {
    console.log('DEBUG: handleReactionAdded called with data:', data);
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (!messageDiv) {
        console.log('DEBUG: Message div not found for message_id:', data.message_id);
        return;
    }
    console.log('DEBUG: Found message div, adding reaction');

    let reactionsDiv = messageDiv.querySelector('.message-reactions');
    if (!reactionsDiv) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'message-reactions';
        
        // Insert reactions div after content but before actions
        const actionsDiv = messageDiv.querySelector('.message-actions');
        if (actionsDiv) {
            messageDiv.insertBefore(reactionsDiv, actionsDiv);
        } else {
        messageDiv.appendChild(reactionsDiv);
        }
    }

    let emojiSpan = reactionsDiv.querySelector(`[data-emoji="${data.emoji}"]`);
    if (!emojiSpan) {
        console.log('DEBUG: Creating new emoji span for', data.emoji);
        emojiSpan = document.createElement('span');
        emojiSpan.className = 'reaction-emoji';
        emojiSpan.dataset.emoji = data.emoji;
        emojiSpan.innerHTML = `${data.emoji} <span class="reaction-count">1</span>`;
        reactionsDiv.appendChild(emojiSpan);
        console.log('DEBUG: Added emoji to reactionsDiv. ReactionsDiv now has', reactionsDiv.children.length, 'reactions');
    } else {
        console.log('DEBUG: Updating existing emoji span for', data.emoji);
        const countSpan = emojiSpan.querySelector('.reaction-count');
        const currentCount = parseInt(countSpan.textContent) || 0;
        countSpan.textContent = currentCount + 1;
        console.log('DEBUG: Updated count to', countSpan.textContent);
    }
    
    // Make sure reactions div is visible
    reactionsDiv.style.display = 'flex';
    console.log('DEBUG: Reactions div display style:', reactionsDiv.style.display);
    console.log('DEBUG: Reactions div HTML:', reactionsDiv.innerHTML);

    showNotification(`${data.username} reacted with ${data.emoji}`, 'info');
}

function handleReactionRemoved(data) {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (!messageDiv) return;

    const reactionsDiv = messageDiv.querySelector('.message-reactions');
    if (!reactionsDiv) return;

    const emojiSpan = reactionsDiv.querySelector(`[data-emoji="${data.emoji}"]`);
    if (!emojiSpan) return;

    const countSpan = emojiSpan.querySelector('.reaction-count');
    const currentCount = parseInt(countSpan.textContent) || 0;

    if (currentCount <= 1) {
        emojiSpan.remove();
        if (reactionsDiv.children.length === 0) {
            reactionsDiv.remove();
        }
    } else {
        countSpan.textContent = currentCount - 1;
    }
}

function handleMessagePinned(data) {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageDiv) {
        messageDiv.classList.add('pinned');
        const pinBtn = messageDiv.querySelector('.message-action-btn');
        if (pinBtn && pinBtn.textContent === '📌') {
            pinBtn.classList.add('pinned');
        }
    }
    showNotification('Message pinned! 📌', 'success');
}

function handleMessageUnpinned(data) {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (messageDiv) {
        messageDiv.classList.remove('pinned');
        const pinBtn = messageDiv.querySelector('.message-action-btn');
        if (pinBtn && pinBtn.textContent === '📌') {
            pinBtn.classList.remove('pinned');
        }
    }
    showNotification('Message unpinned', 'info');
}

function handleReactionsList(data) {
    const messageDiv = document.querySelector(`[data-message-id="${data.message_id}"]`);
    if (!messageDiv) return;

    let reactionsDiv = messageDiv.querySelector('.message-reactions');
    if (reactionsDiv) reactionsDiv.remove();

    if (Object.keys(data.reactions).length > 0) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'message-reactions';

        for (const [emoji, users] of Object.entries(data.reactions)) {
            const emojiSpan = document.createElement('span');
            emojiSpan.className = 'reaction-emoji';
            emojiSpan.dataset.emoji = emoji;
            
            // Handle different data structures
            let count = 1;
            let userList = [];
            
            if (Array.isArray(users)) {
                count = users.length;
                userList = users;
            } else if (typeof users === 'object' && users !== null) {
                count = Object.keys(users).length;
                userList = Object.keys(users);
            } else if (typeof users === 'number') {
                count = users;
            }
            
            emojiSpan.innerHTML = `${emoji} <span class="reaction-count">${count}</span>`;
            emojiSpan.title = userList.length > 0 ? `Reacted by: ${userList.join(', ')}` : `${count} reaction${count !== 1 ? 's' : ''}`;
            reactionsDiv.appendChild(emojiSpan);
        }

        // Insert reactions div after content but before actions
        const contentDiv = messageDiv.querySelector('.message-content');
        const actionsDiv = messageDiv.querySelector('.message-actions');
        
        if (actionsDiv) {
            messageDiv.insertBefore(reactionsDiv, actionsDiv);
        } else {
        messageDiv.appendChild(reactionsDiv);
        }
    }
}

function handlePinnedMessagesList(data) {
    console.log('Pinned messages:', data.pinned_messages);

    const pinnedSection = document.getElementById('pinned-messages-section');
    const pinnedList = document.getElementById('pinned-messages-list');
    
    if (!pinnedSection || !pinnedList) return;

    // Clear existing pinned messages in the section
    pinnedList.innerHTML = '';

    // Show/hide pinned section based on whether there are pinned messages
    if (data.pinned_messages && data.pinned_messages.length > 0) {
        pinnedSection.style.display = 'block';
        
        // Add pinned messages to the section
    data.pinned_messages.forEach(pinInfo => {
            // Mark message as pinned in main chat
        const messageDiv = document.querySelector(`[data-message-id="${pinInfo.message_id}"]`);
        if (messageDiv) {
            messageDiv.classList.add('pinned');
            const pinBtn = messageDiv.querySelector('.message-action-btn');
            if (pinBtn && pinBtn.textContent === '📌') {
                pinBtn.classList.add('pinned');
            }
                
                // Create pinned message item for the top section
                const pinnedItem = document.createElement('div');
                pinnedItem.className = 'pinned-message-item';
                pinnedItem.dataset.messageId = pinInfo.message_id;
                
                const userSpan = document.createElement('div');
                userSpan.className = 'pinned-message-user';
                
                // Try to get username from different possible fields
                let username = 'Unknown';
                if (pinInfo.username) {
                    username = pinInfo.username;
                } else if (pinInfo.user) {
                    username = pinInfo.user;
                } else if (pinInfo.sender) {
                    username = pinInfo.sender;
                } else if (pinInfo.from) {
                    username = pinInfo.from;
                } else if (messageDiv) {
                    // Try to extract from the message div
                    const header = messageDiv.querySelector('.message-header');
                    if (header) {
                        const headerText = header.textContent;
                        const match = headerText.match(/([^:]+):/);
                        if (match) {
                            username = match[1].trim();
                        }
                    }
                }
                
                userSpan.textContent = username;
                
                const contentSpan = document.createElement('div');
                contentSpan.className = 'pinned-message-content';
                
                // Try to get message content from different possible fields
                let messageContent = 'Message content';
                if (pinInfo.message) {
                    messageContent = pinInfo.message;
                } else if (pinInfo.content) {
                    messageContent = pinInfo.content;
                } else if (pinInfo.text) {
                    messageContent = pinInfo.text;
                } else if (messageDiv) {
                    // Try to extract from the message div
                    const content = messageDiv.querySelector('.message-content');
                    if (content) {
                        messageContent = content.textContent || content.innerText || 'Message content';
                    }
                }
                
                // Truncate long messages
                if (messageContent.length > 100) {
                    messageContent = messageContent.substring(0, 100) + '...';
                }
                
                contentSpan.textContent = messageContent;
                
                pinnedItem.appendChild(userSpan);
                pinnedItem.appendChild(contentSpan);
                
                // Scroll to message when clicked
                pinnedItem.addEventListener('click', () => {
                    if (messageDiv) {
                        messageDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        messageDiv.style.animation = 'highlight 1s ease';
                    }
                });
                
                pinnedList.appendChild(pinnedItem);
            }
        });
    } else {
        pinnedSection.style.display = 'none';
    }
}

function loadReactionsForMessage(messageId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'get_reactions',
            message_id: messageId
        }));
    }
}

function loadPinnedMessages() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'get_pinned_messages'
        }));
    }
}

// ==========================
// Highlights Functions
// ==========================
let highlightsModal, closeHighlightsModal, highlightsList, generateHighlightsBtn;
let highlightsTypeSelect, highlightsTargetSelect, highlightsNavBtn;

async function loadHighlights() {
    try {
        console.log('Loading highlights...');
        const params = new URLSearchParams({
            limit: '20'
        });
        
        const response = await fetch(`/highlights?${params}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        console.log('Load response status:', response.status);
        
        if (response.ok) {
            const data = await response.json();
            console.log('Loaded highlights data:', data);
            displayHighlights(data.highlights);
        } else {
            console.error('Failed to load highlights, status:', response.status);
            highlightsList.innerHTML = '<div class="highlight-error">Failed to load highlights</div>';
        }
    } catch (error) {
        console.error('Load highlights error:', error);
        highlightsList.innerHTML = '<div class="highlight-error">Error loading highlights</div>';
    }
}

async function generateHighlights() {
    const generateBtn = generateHighlightsBtn;
    const originalText = generateBtn.textContent;
    
    try {
        generateBtn.textContent = 'Generating...';
        generateBtn.disabled = true;
        
        const requestData = {
            type: highlightsTypeSelect.value,
            target_type: highlightsTargetSelect.value,
            date_range: "auto"
        };
        
        console.log('Sending request:', requestData);
        
        const response = await fetch('/highlights/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(requestData)
        });
        
        console.log('Response status:', response.status);
        
        if (response.ok) {
            const data = await response.json();
            console.log('Response data:', data);
            
            const highlights = Array.isArray(data) ? data : 
                              data.highlights ? data.highlights : [data];
            
            console.log('Highlights to display:', highlights);
            displayHighlights(highlights);
            alert('Highlights generated successfully!');
        } else {
            const errorData = await response.json();
            console.error('Error response:', errorData);
            alert(errorData.error || 'Failed to generate highlights');
        }
    } catch (error) {
        console.error('Exception:', error);
        alert('Error generating highlights');
    } finally {
        generateBtn.textContent = originalText;
        generateBtn.disabled = false;
    }
}

function displayHighlights(highlights) {
    if (!highlights || highlights.length === 0) {
        highlightsList.innerHTML = `
            <div class="no-highlights">
                <h3>No highlights available</h3>
                <p>Generate some highlights to see summaries of your conversations!</p>
            </div>
        `;
        return;
    }
    
    highlightsList.innerHTML = '';
    
    highlights.forEach(highlight => {
        const highlightDiv = document.createElement('div');
        highlightDiv.className = 'highlight-item';
        
        const targetIcon = highlight.target_type === 'group' ? '👥' : '💬';
        const typeIcon = highlight.highlight_type === 'daily' ? '📅' : '📆';
        
        highlightDiv.innerHTML = `
            <div class="highlight-header">
                <div class="highlight-title">
                    <span class="highlight-icon">${targetIcon}</span>
                    <span class="highlight-name">${highlight.target_name}</span>
                    <span class="highlight-type-badge">${typeIcon} ${highlight.highlight_type}</span>
                </div>
                <div class="highlight-stats">
                    <span class="message-count">${highlight.message_count} messages</span>
                    <span class="participant-count">${highlight.participant_count} participants</span>
                </div>
            </div>
            
            <div class="highlight-summary">
                ${highlight.summary}
            </div>
            
            ${highlight.key_topics && highlight.key_topics.length > 0 ? `
                <div class="highlight-topics">
                    <div class="topics-label">Key Topics:</div>
                    <div class="topics-list">
                        ${highlight.key_topics.map(topic => `<span class="topic-tag">${topic}</span>`).join('')}
                    </div>
                </div>
            ` : ''}
            
            <div class="highlight-footer">
                <span class="highlight-period">${highlight.start_date} to ${highlight.end_date}</span>
                <span class="highlight-created">Generated: ${highlight.created_at}</span>
            </div>
        `;
        
        highlightsList.appendChild(highlightDiv);
    });
}

async function generateChatHighlight(chatName, chatType, groupId = null) {
    try {
        const requestData = {
            type: 'recent',
            target_type: chatType,
            date_range: "auto"
        };
        
        if (groupId) {
            requestData.target_id = groupId;
        }
        
        if (chatType === 'personal') {
            requestData.specific_user = chatName;
        }
        
        const response = await fetch('/highlights/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify(requestData)
        });
        
        if (response.ok) {
            const data = await response.json();
            const highlights = Array.isArray(data) ? data : 
                              data.highlights ? data.highlights : [data];
            
            const chatHighlights = highlights.filter(h => 
                h.target_name === chatName || (groupId && h.target_id === groupId)
            );
            
            if (chatHighlights.length > 0) {
                showChatHighlightModal(chatHighlights[0], chatName, chatType);
            } else {
                alert(`No recent activity found for ${chatName}`);
            }
        } else {
            const errorData = await response.json();
            alert(errorData.error || 'Failed to generate highlights');
        }
    } catch (error) {
        console.error('Error generating chat highlights:', error);
        alert('Error generating highlights');
    }
}

function showChatHighlightModal(highlight, chatName, chatType) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.display = 'block';
    
    const icon = chatType === 'group' ? '👥' : '💬';
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 600px;">
            <span class="close" onclick="this.parentElement.parentElement.remove()">&times;</span>
            <h2>${icon} Highlights for ${chatName}</h2>
            
            <div class="highlight-item">
                <div class="highlight-summary" style="margin: 20px 0; font-size: 16px; line-height: 1.6;">
                    ${highlight.summary}
                </div>
                
                ${highlight.key_topics && highlight.key_topics.length > 0 ? `
                    <div class="highlight-topics" style="margin: 20px 0;">
                        <div class="topics-label" style="font-weight: bold; margin-bottom: 10px;">Key Topics:</div>
                        <div class="topics-list">
                            ${highlight.key_topics.map(topic => `<span class="topic-tag">${topic}</span>`).join('')}
                        </div>
                    </div>
                ` : ''}
                
                <div class="highlight-stats" style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #eee; font-size: 14px; color: #666;">
                    <strong>${highlight.message_count}</strong> messages • <strong>${highlight.participant_count}</strong> participants
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// ==========================
// Init
// ==========================
window.addEventListener('DOMContentLoaded', () => {
    authContainer = document.getElementById('auth-container');
    messengerContainer = document.getElementById('messenger-container');
    loginForm = document.getElementById('login-form');
    registerForm = document.getElementById('register-form');
    showRegisterLink = document.getElementById('show-register');
    showLoginLink = document.getElementById('show-login');
    loginBtn = document.getElementById('login-btn');
    registerBtn = document.getElementById('register-btn');
    logoutBtn = document.getElementById('logout-btn');
    currentUserSpan = document.getElementById('current-user');
    contactsList = document.getElementById('contacts-list');
    groupsList = document.getElementById('groups-list');
    availableGroupsList = document.getElementById('available-groups-list');
    welcomeScreen = document.getElementById('welcome-screen');
    chatHeader = document.getElementById('chat-header');
    messagesContainer = document.getElementById('messages-container');
    messageInputArea = document.getElementById('message-input-area');
    messagesDiv = document.getElementById('messages');
    messageInput = document.getElementById('message-input');
    sendBtn = document.getElementById('send-btn');
    chatWithUsername = document.getElementById('chat-with-username');
    imageInput = document.getElementById('image-input');
    imageBtn = document.getElementById('image-btn');

    // Global lock elements
    globalLockBtn = document.getElementById('global-lock-btn');
    globalLockDropdown = document.getElementById('global-lock-dropdown');
    globalLockSet = document.getElementById('global-lock-set');
    globalLockEnable = document.getElementById('global-lock-enable');
    globalLockDisable = document.getElementById('global-lock-disable');
    globalLockChange = document.getElementById('global-lock-change');

    // Settings elements
    settingsBtn = document.getElementById('settings-btn');
    settingsModal = document.getElementById('settings-modal');
    closeSettingsModal = document.getElementById('close-settings-modal');
    settingsPinNotSet = document.getElementById('settings-pin-notset');
    settingsPinSet = document.getElementById('settings-pin-set');
    setPinNew = document.getElementById('set-pin-new');
    setPinConfirm = document.getElementById('set-pin-confirm');
    settingsCancelNotSet = document.getElementById('settings-cancel-notset');
    settingsSetPinBtn = document.getElementById('settings-set-pin-btn');
    chgPinOld = document.getElementById('chg-pin-old');
    chgPinNew = document.getElementById('chg-pin-new');
    chgPinConfirm = document.getElementById('chg-pin-confirm');
    settingsDisablePinBtn = document.getElementById('settings-disable-pin-btn');
    settingsChangePinBtn = document.getElementById('settings-change-pin-btn');

    // Sidebar toggle
    sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');

    // Theme elements
    themeBtn = document.getElementById('theme-btn');
    themeModal = document.getElementById('theme-modal');
    closeThemeModal = document.getElementById('close-theme-modal');
    themeGrid = document.getElementById('theme-grid');

    // Split pane elements
    splitOpenBtn = document.getElementById('split-open-btn');
    splitPane2 = document.getElementById('split-pane-2');
    chatHeader2 = document.getElementById('chat-header-2');
    chatWithUsername2 = document.getElementById('chat-with-username-2');
    messagesContainer2 = document.getElementById('messages-container-2');
    messagesDiv2 = document.getElementById('messages-2');
    messageInputArea2 = document.getElementById('message-input-area-2');
    messageInput2 = document.getElementById('message-input-2');
    sendBtn2 = document.getElementById('send-btn-2');
    splitAddChatBtn = document.getElementById('split-add-chat');
    splitContactsSelect = document.getElementById('split-contacts-select');
    splitCloseBtn = document.getElementById('split-close-btn');

    // Safety: always clear any leftover split UI/artifacts on load
    (function resetSplitUIOnLoad(){
        try {
            const area = document.querySelector('.chat-area');
            if (area) area.classList.remove('split');
            const elIds = ['split-pane-2','split-placeholder','messages-container-2','message-input-area-2','chat-header-2'];
            elIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
            const m2 = document.getElementById('messages-2'); if (m2) m2.innerHTML = '';
            currentConversation2 = null; currentGroup2 = null; pane2ExpectedHistory = null;
            // Reset pane 1 styles to safe defaults
            const mc1 = document.getElementById('messages-container');
            if (mc1) {
                mc1.style.transform = 'none';
                mc1.style.zoom = '1';
                mc1.style.scale = null;
                mc1.style.display = mc1.style.display || 'block';
                mc1.style.overflowY = 'auto';
            }
            const pinned = document.getElementById('pinned-messages-section');
            if (pinned) { pinned.style.position = 'static'; pinned.style.zIndex = 'auto'; }
        } catch {}
    })();

    searchInput = document.getElementById('search-input');
    searchBtn = document.getElementById('search-btn');
    searchResults = document.getElementById('search-results');

    console.log('Search elements initialized:', {
        searchInput: !!searchInput,
        searchBtn: !!searchBtn,
        searchResults: !!searchResults
    });

    createGroupBtn = document.getElementById('create-group-btn');
    createGroupModal = document.getElementById('create-group-modal');
    closeGroupModal = document.getElementById('close-group-modal');
    submitGroupBtn = document.getElementById('submit-group-btn');
    groupNameInput = document.getElementById('group-name');
    groupDescInput = document.getElementById('group-description');
    groupMembersInput = document.getElementById('group-members');
    
    groupMenu = document.getElementById('group-menu');
    groupMenuBtn = document.getElementById('group-menu-btn');
    groupMenuDropdown = document.getElementById('group-menu-dropdown');
    addMembersBtn = document.getElementById('add-members-btn');
    viewMembersBtn = document.getElementById('view-members-btn');
    editGroupBtn = document.getElementById('edit-group-btn');
    leaveGroupBtn = document.getElementById('leave-group-btn');
    toggleGhostBtn = document.getElementById('toggle-ghost-btn');
    
    addMembersModal = document.getElementById('add-members-modal');
    closeAddMembersModal = document.getElementById('close-add-members-modal');
    newMembersInput = document.getElementById('new-members-input');
    submitAddMembersBtn = document.getElementById('submit-add-members-btn');
    
    viewMembersModal = document.getElementById('view-members-modal');
    closeViewMembersModal = document.getElementById('close-view-members-modal');
    membersList = document.getElementById('members-list');
    
    // Poll elements
    createPollModal = document.getElementById('create-poll-modal');
    closePollModal = document.getElementById('close-poll-modal');
    submitPollBtn = document.getElementById('submit-poll-btn');
    pollQuestionInput = document.getElementById('poll-question');
    pollOptionsContainer = document.getElementById('poll-options-container');
    addPollOptionBtn = document.getElementById('add-poll-option-btn');
    allowMultipleCheckbox = document.getElementById('allow-multiple-choices');
    pollExpiresInput = document.getElementById('poll-expires');
    activePollsContainer = document.getElementById('active-polls-container');
    
    // DM lock elements
    dmLockBtn = document.getElementById('dm-lock-btn');
    dmLockModal = document.getElementById('dm-lock-modal');
    closeDMLockModal = document.getElementById('close-dm-lock-modal');
    dmLockPin = document.getElementById('dm-lock-pin');
    dmLockPinConfirm = document.getElementById('dm-lock-pin-confirm');
    dmLockTitle = document.getElementById('dm-lock-title');
    dmLockPrimary = document.getElementById('dm-lock-primary');
    dmLockSecondary = document.getElementById('dm-lock-secondary');
    
    // Highlights elements
    highlightsModal = document.getElementById('highlights-modal');
    closeHighlightsModal = document.getElementById('close-highlights-modal');
    highlightsList = document.getElementById('highlights-list');
    generateHighlightsBtn = document.getElementById('generate-highlights-btn');
    highlightsTypeSelect = document.getElementById('highlights-type');
    highlightsTargetSelect = document.getElementById('highlights-target');
    highlightsNavBtn = document.getElementById('highlights-nav-btn');
    
    console.log('DOM loaded, all elements found');
    console.log('Groups list element:', groupsList);
    console.log('Available groups list element:', availableGroupsList);
    
    setupEventListeners();

    // Global lock menu handlers
    if (globalLockBtn) {
        globalLockBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const st = await fetchGlobalLockStatus();
            // If PIN set: lock now; else show dropdown to set
            if (st.has_pin) {
                // Ensure server-side "enabled" is on so verify works
                try { await enableGlobalLock(); } catch {}
                try { sessionStorage.removeItem('global_unlocked'); } catch {}
                applyGlobalLockOverlay();
            } else {
                await updateGlobalLockMenu();
                if (globalLockDropdown.classList.contains('show')) {
                    globalLockDropdown.classList.remove('show');
                    globalLockDropdown.style.display = 'none';
                } else {
                    globalLockDropdown.classList.add('show');
                    globalLockDropdown.style.display = 'block';
                }
            }
        });
        if (globalLockDropdown) {
            globalLockDropdown.addEventListener('click', (ev) => ev.stopPropagation());
        }
        document.addEventListener('click', () => { if (globalLockDropdown) { globalLockDropdown.classList.remove('show'); globalLockDropdown.style.display='none'; } });
    }

    // Sidebar toggle behavior
    function setSidebarCollapsed(collapsed) {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        if (collapsed) {
            sidebar.classList.add('collapsed');
            try { localStorage.setItem('sidebar_collapsed', '1'); } catch {}
            // Show floating reopen handle
            let reopen = document.getElementById('sidebar-reopen-btn');
            if (!reopen) {
                reopen = document.createElement('button');
                reopen.id = 'sidebar-reopen-btn';
                reopen.className = 'sidebar-reopen-btn';
                reopen.innerHTML = "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='3' y='3' width='18' height='18' rx='3' ry='3' stroke='currentColor' stroke-width='2' fill='none'/><line x1='9' y1='3' x2='9' y2='21' stroke='currentColor' stroke-width='2'/><circle cx='6' cy='7' r='1.4' fill='currentColor'/><circle cx='6' cy='11' r='1.4' fill='currentColor'/><line x1='12' y1='7' x2='18' y2='7' stroke='currentColor' stroke-width='2' stroke-linecap='round'/><line x1='12' y1='11' x2='18' y2='11' stroke='currentColor' stroke-width='2' stroke-linecap='round'/><line x1='12' y1='15' x2='18' y2='15' stroke='currentColor' stroke-width='2' stroke-linecap='round'/></svg>";
                reopen.addEventListener('click', () => setSidebarCollapsed(false));
                document.body.appendChild(reopen);
            }
            reopen.style.display = 'inline-flex';
        } else {
            sidebar.classList.remove('collapsed');
            try { localStorage.setItem('sidebar_collapsed', '0'); } catch {}
            const reopen = document.getElementById('sidebar-reopen-btn');
            if (reopen) reopen.style.display = 'none';
        }
    }
    if (sidebarToggleBtn) {
        sidebarToggleBtn.addEventListener('click', () => {
            const sidebar = document.querySelector('.sidebar');
            const isCollapsed = sidebar && sidebar.classList.contains('collapsed');
            setSidebarCollapsed(!isCollapsed);
        });
        // Initialize from saved state
        const saved = (function(){ try { return localStorage.getItem('sidebar_collapsed'); } catch { return null; } })();
        setSidebarCollapsed(saved === '1');
    }

    // Theme picker
    const THEMES = [
        { key: 'ocean', name: 'Ocean', preview: 'linear-gradient(180deg, #e0f2fe, #7dd3fc)' },
        { key: 'forest', name: 'Forest', preview: 'linear-gradient(180deg, #ecfdf5, #a7f3d0)' },
        { key: 'sunset', name: 'Sunset', preview: 'linear-gradient(180deg, #fff7ed, #fdba74)' },
        { key: 'graphite', name: 'Graphite', preview: 'linear-gradient(180deg, #f3f4f6, #d1d5db)' },
        { key: 'lavender', name: 'Lavender', preview: 'linear-gradient(180deg, #f5f3ff, #ddd6fe)' },
        { key: 'midnight', name: 'Midnight', preview: 'linear-gradient(180deg, #111827, #1f2937)' },
        { key: 'galaxy', name: 'Galaxy', preview: 'linear-gradient(180deg, #0b1020, #111827)' },
        { key: 'love', name: 'Love', preview: 'linear-gradient(180deg, #fff1f2, #fda4af)' },
        { key: 'emojis', name: 'Emojis', preview: 'linear-gradient(180deg, #fef9c3, #e9d5ff)' },
    ];

    async function renderThemeTiles() {
        if (!themeGrid) return;
        themeGrid.innerHTML = '';
        const current = await fetchCurrentTheme();
        THEMES.forEach(t => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.style.display = 'block';
            tile.style.width = '100%';
            tile.style.minHeight = '100px';
            tile.style.height = '100px';
            tile.style.border = '2px solid ' + (current === t.key ? '#4f46e5' : '#e5e7eb');
            tile.style.borderRadius = '12px';
            tile.style.cursor = 'pointer';
            tile.style.background = t.preview;
            tile.style.boxShadow = current === t.key ? '0 0 0 3px rgba(79,70,229,0.25)' : '0 6px 16px rgba(0,0,0,0.08)';
            tile.title = t.name;
            tile.addEventListener('click', async () => {
                const ok = await saveCurrentTheme(t.key);
                if (!ok) { alert('Failed to save theme'); return; }
                applyTheme(t.key);
                if (themeModal) themeModal.style.display = 'none';
            });
            const label = document.createElement('div');
            label.textContent = t.name;
            label.style.marginTop = '6px';
            label.style.fontSize = '12px';
            label.style.fontWeight = '600';
            label.style.textAlign = 'center';
            const wrap = document.createElement('div');
            wrap.style.display = 'flex';
            wrap.style.flexDirection = 'column';
            wrap.style.alignItems = 'center';
            wrap.appendChild(tile);
            wrap.appendChild(label);
            themeGrid.appendChild(wrap);
        });
    }

    if (themeBtn) {
        themeBtn.addEventListener('click', async () => {
            renderThemeTiles();
            if (themeModal) themeModal.style.display = 'block';
        });
    }
    if (closeThemeModal) {
        closeThemeModal.addEventListener('click', () => { if (themeModal) themeModal.style.display = 'none'; });
    }
    // Settings modal logic
    if (settingsBtn) {
        settingsBtn.addEventListener('click', async () => {
            if (!settingsModal) return;
            const st = await fetchGlobalLockStatus();
            if (settingsPinNotSet) settingsPinNotSet.style.display = st.has_pin ? 'none' : 'block';
            if (settingsPinSet) settingsPinSet.style.display = st.has_pin ? 'block' : 'none';
            // Clear inputs
            if (setPinNew) setPinNew.value = '';
            if (setPinConfirm) setPinConfirm.value = '';
            if (chgPinOld) chgPinOld.value = '';
            if (chgPinNew) chgPinNew.value = '';
            if (chgPinConfirm) chgPinConfirm.value = '';
            settingsModal.style.display = 'block';
        });
    }
    if (closeSettingsModal) {
        closeSettingsModal.addEventListener('click', () => { if (settingsModal) settingsModal.style.display = 'none'; });
    }
    if (settingsCancelNotSet) {
        settingsCancelNotSet.addEventListener('click', () => { if (settingsModal) settingsModal.style.display = 'none'; });
    }
    if (settingsSetPinBtn) {
        settingsSetPinBtn.addEventListener('click', async () => {
            const pin = (setPinNew?.value || '').trim();
            const pin2 = (setPinConfirm?.value || '').trim();
            if (pin.length < 4) { alert('PIN must be at least 4 characters'); return; }
            if (pin !== pin2) { alert('PINs do not match'); return; }
            const ok = await setGlobalLock(pin);
            if (!ok) { alert('Failed to set PIN'); return; }
            await updateGlobalLockMenu();
            if (settingsModal) settingsModal.style.display = 'none';
        });
    }
    if (settingsChangePinBtn) {
        settingsChangePinBtn.addEventListener('click', async () => {
            const oldP = (chgPinOld?.value || '').trim();
            const newP = (chgPinNew?.value || '').trim();
            const newP2 = (chgPinConfirm?.value || '').trim();
            if (!oldP) { alert('Enter your current PIN'); return; }
            if (newP.length < 4) { alert('New PIN must be at least 4 characters'); return; }
            if (newP !== newP2) { alert('New PINs do not match'); return; }
            const ok = await changeGlobalLock(oldP, newP);
            if (!ok) { alert('Failed to change PIN (check current PIN)'); return; }
            await updateGlobalLockMenu();
            if (settingsModal) settingsModal.style.display = 'none';
            alert('PIN changed');
        });
    }
    if (settingsDisablePinBtn) {
        settingsDisablePinBtn.addEventListener('click', async () => {
            const ok = await disableGlobalLock();
            if (!ok) { alert('Failed to disable lock'); return; }
            await updateGlobalLockMenu();
            if (settingsModal) settingsModal.style.display = 'none';
        });
    }
    if (globalLockSet) {
        globalLockSet.addEventListener('click', async () => {
            globalLockDropdown.classList.remove('show');
            const pin = prompt('Set a new global PIN (min 4)');
            if (!pin || pin.trim().length < 4) return;
            const ok = await setGlobalLock(pin.trim());
            if (!ok) { alert('Failed to set PIN'); return; }
            try { sessionStorage.removeItem('global_unlocked'); } catch {}
            await updateGlobalLockMenu();
            applyGlobalLockOverlay();
        });
    }
    // Remove enable/disable behavior from UI per new spec
    if (globalLockChange) {
        globalLockChange.addEventListener('click', async () => {
            globalLockDropdown.classList.remove('show');
            const oldPin = prompt('Enter current global PIN');
            if (!oldPin) return;
            const newPin = prompt('Enter new PIN (min 4)');
            if (!newPin || newPin.trim().length < 4) return;
            const ok = await changeGlobalLock(oldPin.trim(), newPin.trim());
            if (!ok) { alert('Failed to change PIN'); return; }
            await updateGlobalLockMenu();
            alert('PIN changed');
        });
    }

    // Split pane logic (disabled until re-implementation)
    if (!splitEnabled && splitOpenBtn) { try { splitOpenBtn.style.display = 'none'; } catch {} }
    // Do not return here; continue with the rest of app initialization
    let currentConversation2 = null;
    let currentGroup2 = null;
    let pane2ExpectedHistory = null;

    function enableSplitLayout(enable) {
        const area = document.querySelector('.chat-area');
        if (!area) return;
        if (enable) {
            area.classList.add('split');
            if (splitPane2) splitPane2.style.display = 'flex';
        } else {
            area.classList.remove('split');
            if (splitPane2) splitPane2.style.display = 'none';
        }
    }

    async function openSplitForUser(username) {
        enableSplitLayout(true);
        currentConversation2 = username; currentGroup2 = null;
        if (chatHeader2) chatHeader2.style.display = 'block';
        if (chatWithUsername2) chatWithUsername2.textContent = username;
        if (messagesContainer2) messagesContainer2.style.display = 'block';
        if (messageInputArea2) messageInputArea2.style.display = 'block';
        if (messageInput2) messageInput2.disabled = false;
        if (sendBtn2) sendBtn2.disabled = false;
        if (messagesDiv2) messagesDiv2.innerHTML = '';
        const placeholder = document.getElementById('split-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        // Request history targeted for pane2
        if (socket && socket.readyState === WebSocket.OPEN) {
            pane2ExpectedHistory = username;
            socket.send(JSON.stringify({ type: 'get_conversation', receiver_username: username }));
        }
    }

    if (splitOpenBtn) {
        splitOpenBtn.addEventListener('click', async () => {
            enableSplitLayout(true);
            if (messagesContainer2) messagesContainer2.style.display = 'block';
            if (messageInputArea2) messageInputArea2.style.display = 'none';
            if (chatHeader2) { chatHeader2.style.display = 'block'; chatWithUsername2.textContent = 'Select a chat'; }
            const ph = document.getElementById('split-placeholder');
            if (ph) ph.style.display = 'flex';
        });
    }

    if (splitAddChatBtn) {
        splitAddChatBtn.addEventListener('click', () => {
            if (!splitContactsSelect) return;
            // Populate contacts if empty
            if (splitContactsSelect.options.length <= 1 && Array.isArray(contacts)) {
                contacts.forEach(u => {
                    const opt = document.createElement('option');
                    opt.value = u; opt.textContent = u;
                    splitContactsSelect.appendChild(opt);
                });
            }
            splitContactsSelect.style.display = splitContactsSelect.style.display === 'none' ? 'inline-block' : 'none';
        });
    }
    if (splitContactsSelect) {
        splitContactsSelect.addEventListener('change', async () => {
            const val = splitContactsSelect.value;
            if (!val) return;
            await openSplitForUser(val);
        });
    }
    if (splitCloseBtn) {
        splitCloseBtn.addEventListener('click', () => {
            // Clear pane2 and collapse layout
            currentConversation2 = null; currentGroup2 = null; pane2ExpectedHistory = null;
            if (messagesDiv2) messagesDiv2.innerHTML = '';
            if (messagesContainer2) messagesContainer2.style.display = 'none';
            if (messageInputArea2) messageInputArea2.style.display = 'none';
            if (chatHeader2) chatHeader2.style.display = 'none';
            enableSplitLayout(false);
        });
    }

    if (sendBtn2) {
        sendBtn2.addEventListener('click', () => {
            const text = (messageInput2 ? messageInput2.value.trim() : '');
            if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
            if (currentConversation2) {
                socket.send(JSON.stringify({ type: 'chat_message', receiver_username: currentConversation2, message: text, timestamp: getCurrentTime() }));
            } else if (currentGroup2) {
                socket.send(JSON.stringify({ type: 'group_message', group_id: currentGroup2.id, message: text, timestamp: getCurrentTime() }));
            }
            if (messageInput2) messageInput2.value = '';
        });
    }
    
    // Add highlights event listeners
    if (highlightsNavBtn) {
        highlightsNavBtn.addEventListener('click', () => {
            highlightsModal.style.display = 'block';
            loadHighlights();
        });
    }

    if (closeHighlightsModal) {
        closeHighlightsModal.addEventListener('click', () => {
            highlightsModal.style.display = 'none';
        });
    }

    if (generateHighlightsBtn) {
        generateHighlightsBtn.addEventListener('click', generateHighlights);
    }

    // DM lock listeners
    if (closeDMLockModal) {
        closeDMLockModal.addEventListener('click', () => { if (dmLockModal) dmLockModal.style.display = 'none'; });
    }
    if (dmLockBtn) {
        dmLockBtn.addEventListener('click', async () => {
            if (!currentConversation) return;
            const status = await fetchDMLockStatus(currentConversation);
            if (status.locked) {
                openDMLockModal('manage');
            } else {
                if (status.ever_set) {
                    const ok = await setDMLock(currentConversation, '');
                    if (!ok) { openDMLockModal('set'); return; }
                    applyDMLockUI(currentConversation);
                    messageInput.disabled = true;
                    sendBtn.disabled = true;
                } else {
                    openDMLockModal('set');
                }
            }
        });
    }

    // Search functionality
    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            searchMessages(searchInput.value);
        });
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchMessages(searchInput.value);
            }
        });

        // Real-time search as user types
        searchInput.addEventListener('input', () => {
            if (searchInput.value.length > 2) {
                searchMessages(searchInput.value);
            } else if (searchInput.value.length === 0) {
                searchResults.style.display = 'none';
            }
        });
    }

    const savedToken = localStorage.getItem('authToken');
    const savedUser = localStorage.getItem('currentUser');

    if (savedToken && savedUser) {
        authToken = savedToken;
        currentUser = savedUser;
        showMessengerInterface();
        loadContacts();
        loadGroups();
        loadNotes();
        // Auto-enforce global lock on load if a PIN exists and session not yet unlocked
        (async () => {
            try {
                const st = await fetchGlobalLockStatus();
                if (st && st.has_pin) {
                    try { await enableGlobalLock(); } catch {}
                    if (sessionStorage.getItem('global_unlocked') !== '1') {
                        applyGlobalLockOverlay();
                    }
                }
            } catch {}
        })();
    } else {
        showAuthInterface();
        showLoginForm();
    }

    initializeAIAssistant();
    initializeGameElements();
    
    // Ensure game modal close handler is set up
    const gameModalElement = document.getElementById('game-modal');
    const closeGameModalElement = document.getElementById('close-game-modal');
    
    if (gameModalElement && closeGameModalElement) {
        closeGameModalElement.addEventListener('click', () => {
            gameModalElement.style.display = 'none';
            currentGame = null;
        });
        
        // Close on outside click
        gameModalElement.addEventListener('click', (e) => {
            if (e.target === gameModalElement) {
                gameModalElement.style.display = 'none';
                currentGame = null;
            }
        });
    }
    
    // Close game modal on escape key
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            const modal = gameModal || document.getElementById('game-modal');
            if (modal && modal.style.display === 'block') {
                modal.style.display = 'none';
                currentGame = null;
            }
        }
    });
    
    console.log('Game system initialized successfully');
});

// Make functions globally available for onclick handlers
window.removePollOption = removePollOption;
window.submitVote = submitVote;
window.createGame = createGame;
window.joinGame = joinGame;
window.loadGame = loadGame;
window.extractGameId = extractGameId;
window.handleGameWebSocketMessage = handleGameWebSocketMessage;
window.displayGameMessage = displayGameMessage;
window.sendQuickMessage = sendQuickMessage;
window.generateChatHighlight = generateChatHighlight;
window.requestNextQuestion = requestNextQuestion;

console.log('Game system integration loaded');

// ---------------- DM Lock helpers ----------------
function dmLockKey(user) { return `dm_lock_${user}`; }
function dmUnlockedKey(user) { return `dm_unlocked_${user}`; }

function isDMLocked(user) {
    try { return !!localStorage.getItem(dmLockKey(user)); } catch { return false; }
}
function isDMUnlocked(user) {
    try { return sessionStorage.getItem(dmUnlockedKey(user)) === '1'; } catch { return false; }
}
function setDMUnlocked(user, v) { try { sessionStorage.setItem(dmUnlockedKey(user), v ? '1' : '0'); } catch {} }

async function sha256Hex(text) {
    try {
        if (window.crypto && crypto.subtle) {
            const data = new TextEncoder().encode(text);
            const hash = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch {}
    return btoa(text);
}

function randomSalt() {
    const arr = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function updateDMLockButton() {
    if (!dmLockBtn || !currentConversation) return;
    dmLockBtn.textContent = isDMLocked(currentConversation) ? '🔓 Manage Lock' : '🔒 Lock';
}

function openDMLockModal(mode) {
    if (!dmLockModal) return;
    dmLockModal.style.display = 'block';
    if (mode === 'unlock') {
        dmLockTitle.textContent = `Unlock chat with ${currentConversation}`;
        dmLockPin.value = '';
        dmLockPinConfirm.value = '';
        document.getElementById('dm-lock-confirm-wrap').style.display = 'none';
        dmLockPrimary.textContent = 'Unlock';
        dmLockSecondary.textContent = 'Cancel';
        dmLockPrimary.onclick = async () => {
            const entry = getDMLockEntry(currentConversation);
            const pin = dmLockPin.value.trim();
            const candidate = await sha256Hex(entry.salt + pin);
            if (candidate === entry.hash) {
                setDMUnlocked(currentConversation, true);
                dmLockModal.style.display = 'none';
                removeDMLockUI();
                messageInput.disabled = false;
                sendBtn.disabled = false;
                clearMessages();
                loadConversation(currentConversation);
            } else {
                alert('Incorrect PIN');
            }
        };
        dmLockSecondary.onclick = () => { dmLockModal.style.display = 'none'; };
    } else if (mode === 'set') {
        dmLockTitle.textContent = `Set lock for ${currentConversation}`;
        dmLockPin.value = '';
        dmLockPinConfirm.value = '';
        document.getElementById('dm-lock-confirm-wrap').style.display = 'block';
        dmLockPrimary.textContent = 'Set Lock';
        dmLockSecondary.textContent = 'Cancel';
        dmLockPrimary.onclick = async () => {
            const pin = dmLockPin.value.trim();
            const pin2 = dmLockPinConfirm.value.trim();
            if (pin.length < 4) { alert('PIN must be at least 4 characters'); return; }
            if (pin !== pin2) { alert('PINs do not match'); return; }
            const ok = await setDMLock(currentConversation, pin);
            if (!ok) { alert('Lock already exists or failed to set'); return; }
            setDMUnlocked(currentConversation, false);
            dmLockModal.style.display = 'none';
            applyDMLockUI(currentConversation);
            updateDMLockButton();
            messageInput.disabled = true;
            sendBtn.disabled = true;
        };
        dmLockSecondary.onclick = () => { dmLockModal.style.display = 'none'; };
    } else if (mode === 'manage') {
        dmLockTitle.textContent = `Manage lock for ${currentConversation}`;
        dmLockPin.value = '';
        dmLockPinConfirm.value = '';
        document.getElementById('dm-lock-confirm-wrap').style.display = 'none';
        dmLockPrimary.textContent = 'Disable Lock';
        dmLockSecondary.textContent = 'Change PIN';
        dmLockPrimary.onclick = async () => {
            const ok = await deleteDMLock(currentConversation);
            if (!ok) { alert('Failed to disable lock'); return; }
            setDMUnlocked(currentConversation, false);
            dmLockModal.style.display = 'none';
            updateDMLockButton();
            removeDMLockUI();
        };
        dmLockSecondary.onclick = () => {
            // Switch to change mode
            dmLockTitle.textContent = `Change PIN for ${currentConversation}`;
            document.getElementById('dm-lock-confirm-wrap').style.display = 'block';
            dmLockPrimary.textContent = 'Update PIN';
            dmLockSecondary.textContent = 'Cancel';
            dmLockPin.value = '';
            dmLockPinConfirm.value = '';
            const oldWrap = document.createElement('div');
            oldWrap.className = 'form-group';
            oldWrap.id = 'dm-lock-old-wrap';
            oldWrap.innerHTML = '<label for="dm-lock-old-pin">Current PIN</label><input type="password" id="dm-lock-old-pin" placeholder="current PIN" />';
            const body = document.getElementById('dm-lock-body');
            if (!document.getElementById('dm-lock-old-pin')) body.insertBefore(oldWrap, body.firstChild.nextSibling);
            dmLockPrimary.onclick = async () => {
                const oldPin = (document.getElementById('dm-lock-old-pin')||{}).value || '';
                const newPin = dmLockPin.value.trim();
                const newPin2 = dmLockPinConfirm.value.trim();
                if (newPin.length < 4) { alert('New PIN must be at least 4 characters'); return; }
                if (newPin !== newPin2) { alert('New PINs do not match'); return; }
                const ok = await changeDMLock(currentConversation, oldPin, newPin);
                if (!ok) { alert('Failed to change PIN (check current PIN)'); return; }
                dmLockModal.style.display = 'none';
            };
            dmLockSecondary.onclick = () => { dmLockModal.style.display = 'none'; };
        };
    }
}

function getDMLockEntry(user) {
    try { const raw = localStorage.getItem(dmLockKey(user)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function saveDMLockEntry(user, entry) { try { localStorage.setItem(dmLockKey(user), JSON.stringify(entry)); } catch {} }
function removeDMLockEntry(user) { try { localStorage.removeItem(dmLockKey(user)); } catch {} }

// Server-backed DM lock helpers
async function fetchDMLockStatus(peer) {
    try {
        const res = await fetch(`/dm_lock?peer=${encodeURIComponent(peer)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return { locked: false };
        const data = await res.json();
        return { locked: !!data.locked };
    } catch { return { locked: false }; }
}

async function setDMLock(peer, pin) {
    const res = await fetch('/dm_lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ peer_username: peer, pin })
    });
    return res.ok;
}

async function changeDMLock(peer, oldPin, newPin) {
    const res = await fetch('/dm_lock', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ peer_username: peer, old_pin: oldPin, new_pin: newPin })
    });
    return res.ok;
}

async function verifyDMLock(peer, pin) {
    const res = await fetch('/dm_lock/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ peer_username: peer, pin })
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
}

async function deleteDMLock(peer) {
    const res = await fetch(`/dm_lock?peer=${encodeURIComponent(peer)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
    });
    return res.ok;
}

// Global lock API
async function fetchGlobalLockStatus() {
    try {
        const res = await fetch('/global_lock', { headers: { 'Authorization': `Bearer ${authToken}` } });
        console.log('GLOBAL status resp', res.status);
        if (!res.ok) return { enabled: false, has_pin: false };
        const data = await res.json();
        console.log('GLOBAL status data', data);
        return data;
    } catch { return { enabled: false, has_pin: false }; }
}
async function setGlobalLock(pin) {
    const res = await fetch('/global_lock', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ pin })
    });
    console.log('GLOBAL set resp', res.status);
    return res.ok;
}
async function enableGlobalLock() {
    const res = await fetch('/global_lock', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({})
    });
    console.log('GLOBAL enable resp', res.status);
    return res.ok;
}
async function disableGlobalLock() {
    const res = await fetch('/global_lock', { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
    console.log('GLOBAL disable resp', res.status);
    return res.ok;
}
async function changeGlobalLock(old_pin, new_pin) {
    const res = await fetch('/global_lock', {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ old_pin, new_pin })
    });
    console.log('GLOBAL change resp', res.status);
    return res.ok;
}
async function verifyGlobalLock(pin) {
    const res = await fetch('/global_lock/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ pin })
    });
    console.log('GLOBAL verify resp', res.status);
    let data = {};
    try { data = await res.json(); } catch {}
    console.log('GLOBAL verify data', data);
    return (res.status === 200 && data && data.ok === true);
}

async function updateGlobalLockMenu() {
    const st = await fetchGlobalLockStatus();
    if (globalLockSet) globalLockSet.style.display = st.has_pin ? 'none' : 'block';
    if (globalLockChange) globalLockChange.style.display = st.has_pin ? 'block' : 'none';
    // Hide enable/disable per new spec
    if (globalLockEnable) globalLockEnable.style.display = 'none';
    if (globalLockDisable) globalLockDisable.style.display = 'none';
}

function applyGlobalLockOverlay() {
    if (sessionStorage.getItem('global_unlocked') === '1') return;
    let ov = document.getElementById('global-lock-overlay');
    if (ov) return;
    ov = document.createElement('div');
    ov.id = 'global-lock-overlay';
    ov.className = 'global-lock-overlay';
    const card = document.createElement('div');
    card.style.background = 'white';
    card.style.borderRadius = '12px';
    card.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';
    card.style.padding = '16px';
    card.style.minWidth = '260px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '10px';
    const title = document.createElement('div');
    title.textContent = '🔐 App locked — enter PIN to continue';
    title.style.fontWeight = '600';
    title.style.fontSize = '14px';
    const input = document.createElement('input');
    input.type = 'password'; input.placeholder = 'Enter PIN'; input.style.padding = '10px'; input.style.border = '1px solid #ddd'; input.style.borderRadius = '6px'; input.style.fontSize = '14px';
    const btn = document.createElement('button'); btn.className = 'send-btn'; btn.textContent = 'Unlock';
    btn.onclick = async () => {
        const pin = input.value.trim();
        console.log('GLOBAL attempting verify');
        const ok = await verifyGlobalLock(pin);
        if (ok) {
            sessionStorage.setItem('global_unlocked','1');
            document.body.removeChild(ov);
        } else {
            title.textContent = '❌ Incorrect PIN — try again';
            title.style.color = '#dc3545';
            input.value='';
            input.focus();
        }
    };
    card.appendChild(title); card.appendChild(input); card.appendChild(btn);
    ov.appendChild(card);
    document.body.appendChild(ov);
    setTimeout(() => { try { input.focus(); } catch {} }, 0);
}

function removeGlobalLockOverlay() {
    const ov = document.getElementById('global-lock-overlay');
    if (ov && ov.parentElement) ov.parentElement.removeChild(ov);
}

function applyDMLockUI(peer) {
    try {
        const chatArea = document.querySelector('.chat-area');
        if (!chatArea) return;
        if (document.getElementById('dm-lock-overlay')) return;
        const ov = document.createElement('div');
        ov.id = 'dm-lock-overlay';
        ov.className = 'dm-lock-overlay';
        if (peer) ov.setAttribute('data-peer', peer);
        const card = document.createElement('div');
        card.style.background = 'white';
        card.style.borderRadius = '12px';
        card.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';
        card.style.padding = '16px';
        card.style.minWidth = '260px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '10px';
        const title = document.createElement('div');
        title.textContent = '🔒 Chat locked — enter PIN to view';
        title.style.fontWeight = '600';
        title.style.fontSize = '14px';
        const input = document.createElement('input');
        input.type = 'password';
        input.placeholder = 'Enter PIN';
        input.style.padding = '10px';
        input.style.border = '1px solid #ddd';
        input.style.borderRadius = '6px';
        input.style.fontSize = '14px';
        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '8px';
        actions.style.justifyContent = 'flex-end';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'send-btn';
        cancelBtn.style.background = '#6c757d';
        const unlockBtn = document.createElement('button');
        unlockBtn.textContent = 'Unlock';
        unlockBtn.className = 'send-btn';
        actions.appendChild(cancelBtn);
        actions.appendChild(unlockBtn);
        card.appendChild(title);
        card.appendChild(input);
        card.appendChild(actions);
        ov.appendChild(card);
        chatArea.appendChild(ov);
        setTimeout(() => { try { input.focus(); } catch {} }, 0);

        const attempt = async () => {
            const pin = input.value.trim();
            const peerAttr = ov.getAttribute('data-peer');
            const peerToUnlock = peerAttr || currentConversation;
            const ok = await verifyDMLock(peerToUnlock, pin);
            if (ok) {
                setDMUnlocked(peerToUnlock, true);
                removeDMLockUI();
                messageInput.disabled = false;
                sendBtn.disabled = false;
                clearMessages();
                loadConversation(peerToUnlock);
            } else {
                title.textContent = '❌ Incorrect PIN — try again';
                title.style.color = '#dc3545';
                input.value = '';
                input.focus();
            }
        };

        unlockBtn.addEventListener('click', attempt);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
        cancelBtn.addEventListener('click', () => { removeDMLockUI(); });
    } catch {}
}

function removeDMLockUI() {
    const ov = document.getElementById('dm-lock-overlay');
    if (ov && ov.parentElement) ov.parentElement.removeChild(ov);
}

// ---------------- Chat Themes ----------------
async function fetchCurrentTheme() {
    if (!authToken) return null;
    try {
        if (currentConversation) {
            const res = await fetch(`/chat_theme?peer=${encodeURIComponent(currentConversation)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (!res.ok) return null;
            const data = await res.json();
            return data.theme_key || null;
        }
        if (currentGroup && currentGroup.id) {
            const res = await fetch(`/chat_theme?group_id=${currentGroup.id}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (!res.ok) return null;
            const data = await res.json();
            return data.theme_key || null;
        }
    } catch {}
    return null;
}

async function saveCurrentTheme(themeKey) {
    if (!authToken) return false;
    try {
        const body = currentConversation
            ? { peer_username: currentConversation, theme_key: themeKey }
            : (currentGroup && currentGroup.id ? { group_id: currentGroup.id, theme_key: themeKey } : null);
        if (!body) return false;
        const res = await fetch('/chat_theme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify(body)
        });
        return res.ok;
    } catch { return false; }
}

function applyTheme(themeKey) {
    if (!messagesContainer) return;
    const classes = (messagesContainer.className || '').split(/\s+/).filter(Boolean);
    const filtered = classes.filter(c => !c.startsWith('theme-'));
    messagesContainer.className = filtered.join(' ');
    if (themeKey) messagesContainer.classList.add(`theme-${themeKey}`);
}

async function loadAndApplyThemeForCurrent() {
    const theme = await fetchCurrentTheme();
    applyTheme(theme);
}