const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const fgCanvas = document.getElementById('fgCanvas');
const fgCtx = fgCanvas.getContext('2d');

// --- Configuration ---
const CONFIG = {
    gravity: 0.35,        // Increased gravity for more "weight"
    webLengthMin: 50,
    webLengthMax: 500,    // Increased range
    swingBoost: 1.15,     // More speed on release
    pullForce: 0.5,       // Force when "holding" the swing
    airFriction: 0.985,
    groundFriction: 0.94,
    cameraCatchup: 0.08,
    maxFallSpeed: 16,
    swingElasticity: 0.8, // How much the web "stretches"
    adFrequency: 1.0      // 100% chance for a building to have an ad
};

// --- Ads (Adsterra Placeholders) ---
// User can replace these with their actual Adsterra script tags
const AD_TEMPLATES = [
    { type: 'square',    width: 300, height: 250, key: '6072270e29d424cf8f22eca970769190' },
    { type: 'wide',      width: 728, height: 90,  key: 'e5746ef115d17ae9083360afbc4eb307' },
    { type: 'wide_sm',   width: 468, height: 60,  key: 'c3a021b704f4d410018ba1ce0af2962a' },
    { type: 'tall',      width: 160, height: 600, key: 'd07f8172199f22fd10b8e01ef4816e0b' },
    { type: 'tall_sm',   width: 160, height: 300, key: '4cbf7f90735c4e43f0af15227850a108' },
    { type: 'mobile',    width: 320, height: 50,  key: '68e519d6f3b93cabd168d0aa47f013f1' }
];
const AD_SETTINGS = {
    format: 'iframe',
    loadInterval: 1500,   // Load a new ad every 1.5 seconds (was 3s)
    maxActiveAds: 12      // Slightly increased limit
};

let adLoadTimer = 0;
let activeAdCount = 0;

// --- Game State ---
let gameState = {
    running: false,
    score: 0,
    distance: 0,
    cameraX: 0,
    cameraY: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    timeScale: 1.0,
    shake: 0
};

// --- Player ---
const player = {
    x: 100,
    y: 0,
    vx: 5,
    vy: 0,
    radius: 8,

    // State
    state: 'falling',
    anchor: null,
    ropeLength: 0,
    grounded: false,
    hasSwung: false, // For initial slomo logic

    // Animation
    animTimer: 0,
    limbAngle: 0,
    trails: [] // Motion trail
};

// --- Sprite Pre-processing (Chroma Key) ---
function processSpriteSheet(img, callback) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // More aggressive removal: catch near-black and fade edges
    for (let i = 0; i < data.length; i += 4) {
        let r = data[i], g = data[i+1], b = data[i+2];
        let brightness = (r + g + b) / 3;
        
        if (brightness < 45) {
            // Smoothly fade pixels that are nearly black
            if (brightness < 25) {
                data[i+3] = 0; // Pure transparent
            } else {
                // Fade from 25 to 45 brightness
                let alphaFactor = (brightness - 25) / 20;
                data[i+3] = Math.floor(data[i+3] * alphaFactor);
            }
        }
    }
    ctx.putImageData(imageData, 0, 0);
    const newImg = new Image();
    newImg.onload = () => callback(newImg);
    newImg.src = canvas.toDataURL();
}

// --- Image Assets ---
const sprites = {
    run: { src: 'sheets/run.png', img: new Image(), loaded: false, cols: 5, rows: 5, totalFrames: 25 },
    swing: { src: 'sheets/swing.png', img: new Image(), loaded: false, cols: 5, rows: 5, totalFrames: 25 },
    bird: { src: 'sheets/bird.png', img: new Image(), loaded: false, cols: 6, rows: 6, totalFrames: 36 }
};

// Load all sprites with pre-processing to ensure transparency
Object.keys(sprites).forEach(key => {
    const s = sprites[key];
    const tempImg = new Image();
    tempImg.onload = () => {
        processSpriteSheet(tempImg, (processed) => {
            s.img = processed;
            s.loaded = true;
        });
    };
    tempImg.src = s.src;
});

// --- Sounds ---
const sounds = {
    thwip: new Audio('sound/thwip.mp3')
};
sounds.thwip.preload = 'auto';
sounds.thwip.volume = 0.1; // Reduced volume

function playSound(audioObj) {
    if (audioObj) {
        audioObj.currentTime = 0;
        audioObj.play().catch(e => console.log('Audio play failed:', e));
    }
}

function stopSound(audioObj) {
    if (audioObj) {
        audioObj.pause();
    }
}

// --- World ---
let buildings = [];
let anchors = [];
let particles = [];
let flock = [];

// --- Input ---
let input = {
    active: false
};

// --- Mobile Detection ---
const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || ('ontouchstart' in window)
    || (navigator.maxTouchPoints > 0);

// --- Portrait Rotation (force landscape view on portrait mobile) ---
let isPortrait = false; // true when we need to rotate the canvas

const isMobileDevice = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1);

// --- Mobile Touch State ---
let touchState = {
    startY: 0,
    currentY: 0,
    isSwiping: false,
    climbDirection: 0,  // -1 = climb up, 1 = climb down, 0 = none
    // On-screen button states
    climbUpActive: false,
    climbDownActive: false,
    // Button layout (set in resize)
    btnSize: 60,
    btnMargin: 20,
    btnUpX: 0, btnUpY: 0,
    btnDownX: 0, btnDownY: 0
};

function updateMobileButtonLayout() {
    let s = Math.min(gameState.width, gameState.height) * 0.08;
    touchState.btnSize = Math.max(44, Math.min(s, 70)); // 44px min for accessibility
    touchState.btnMargin = 20;
    // Place climb buttons on the right side
    touchState.btnUpX = gameState.width - touchState.btnSize - touchState.btnMargin;
    touchState.btnUpY = gameState.height * 0.35;
    touchState.btnDownX = gameState.width - touchState.btnSize - touchState.btnMargin;
    touchState.btnDownY = gameState.height * 0.35 + touchState.btnSize + 15;
}

function isInsideButton(tx, ty, bx, by, size) {
    // Generous hit area (1.3x) for fat finger friendliness
    let half = size * 0.65;
    let cx = bx + size / 2;
    let cy = by + size / 2;
    return tx >= cx - half && tx <= cx + half && ty >= cy - half && ty <= cy + half;
}

// Transform screen touch coordinates to game canvas coordinates
// When canvas is rotated 90° (portrait mode), we need to remap
function transformTouchCoords(screenX, screenY) {
    if (isPortrait) {
        // Canvas is rotated 90° clockwise via CSS
        // Screen (x, y) -> Canvas (y, screenW - x) where screenW is the CSS viewport width
        let screenW = window.innerWidth;
        return {
            x: screenY,
            y: screenW - screenX
        };
    }
    return { x: screenX, y: screenY };
}

// --- Initialization ---
function init() {
    resize();
    window.addEventListener('resize', resize);
    // Also listen for orientation changes on mobile
    window.addEventListener('orientationchange', () => {
        setTimeout(resize, 100); // Slight delay for browser to update dimensions
    });

    // --- Mouse (Desktop) ---
    canvas.addEventListener('mousedown', handleInputStart);
    window.addEventListener('mouseup', handleInputEnd);

    // --- Touch (Mobile) ---
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        let touch = e.touches[0];
        let coords = transformTouchCoords(touch.clientX, touch.clientY);
        let tx = coords.x;
        let ty = coords.y;

        // Check if touching climb buttons
        if (isMobile && player.state === 'swinging') {
            if (isInsideButton(tx, ty, touchState.btnUpX, touchState.btnUpY, touchState.btnSize)) {
                touchState.climbUpActive = true;
                touchState.climbDirection = -1;
                return;
            }
            if (isInsideButton(tx, ty, touchState.btnDownX, touchState.btnDownY, touchState.btnSize)) {
                touchState.climbDownActive = true;
                touchState.climbDirection = 1;
                return;
            }
        }

        // Track swipe start for gesture-based climbing
        touchState.startY = ty;
        touchState.currentY = ty;
        touchState.isSwiping = false;
        touchState.climbDirection = 0;

        handleInputStart(touch);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (e.touches.length === 0) return;
        let touch = e.touches[0];
        let coords = transformTouchCoords(touch.clientX, touch.clientY);
        let ty = coords.y;
        touchState.currentY = ty;

        // Swipe-to-climb while swinging
        if (player.state === 'swinging') {
            let deltaY = ty - touchState.startY;
            let swipeThreshold = 15; // px threshold before registering as swipe

            if (Math.abs(deltaY) > swipeThreshold) {
                touchState.isSwiping = true;
                // Continuous climbing based on swipe distance
                let climbSpeed = 3.0;
                let climbAmount = (deltaY > 0 ? 1 : -1) * climbSpeed;
                player.ropeLength += climbAmount;

                // Constrain
                if (player.ropeLength < CONFIG.webLengthMin) player.ropeLength = CONFIG.webLengthMin;
                if (player.ropeLength > CONFIG.webLengthMax) player.ropeLength = CONFIG.webLengthMax;

                // Reset start for continuous feel
                touchState.startY = ty;
            }
        }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
        // Don't prevent default on UI elements (restart button, etc.)
        // This allows the browser to synthesize click events for buttons
        let isUIElement = e.target && (
            e.target.closest('#game-over') ||
            e.target.closest('button') ||
            e.target.tagName === 'BUTTON'
        );
        if (!isUIElement) {
            e.preventDefault();
        }
        // Release climb buttons
        touchState.climbUpActive = false;
        touchState.climbDownActive = false;
        touchState.climbDirection = 0;
        touchState.isSwiping = false;
        handleInputEnd();
    }, { passive: false });

    window.addEventListener('touchcancel', (e) => {
        touchState.climbUpActive = false;
        touchState.climbDownActive = false;
        touchState.climbDirection = 0;
        touchState.isSwiping = false;
        handleInputEnd();
    });

    // --- Keyboard (PC) ---
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault(); // Prevent scrolling
            if (!input.active) handleInputStart();
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            handleInputEnd();
        }
    });

    // Mouse Wheel to Climb Up/Down rope (Desktop)
    window.addEventListener('wheel', (e) => {
        if (player.state === 'swinging') {
            e.preventDefault();
            let climbSpeed = 0.5;
            player.ropeLength += e.deltaY * climbSpeed;

            // Constrain
            if (player.ropeLength < CONFIG.webLengthMin) player.ropeLength = CONFIG.webLengthMin;
            if (player.ropeLength > CONFIG.webLengthMax) player.ropeLength = CONFIG.webLengthMax;
        }
    }, { passive: false });

    // --- Prevent all mobile browser gestures ---
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    // Prevent pull-to-refresh and overscroll
    document.body.addEventListener('touchmove', (e) => {
        if (e.target === canvas || e.target === document.body) {
            e.preventDefault();
        }
    }, { passive: false });

    document.getElementById('restart-btn').addEventListener('click', () => {
        resetGame();
        lastTime = 0;
        requestAnimationFrame(loop);
    });

    // Also handle touch on restart button for mobile
    document.getElementById('restart-btn').addEventListener('touchend', (e) => {
        e.preventDefault();
        e.stopPropagation();
        resetGame();
        lastTime = 0;
        requestAnimationFrame(loop);
    });

    resetGame();
    requestAnimationFrame(loop);
}

function handleInputStart(e) {
    if (!gameState.running) return;
    input.active = true;

    // Visual feedback for input (Ripple)
    particles.push({
        x: player.x,
        y: player.y,
        vx: 0,
        vy: 0,
        life: 20,
        type: 'input_ripple'
    });

    // Attempt attach immediately on press
    if (player.state !== 'swinging') {
        tryAttachWeb();
    }
}

function handleInputEnd() {
    input.active = false;
    if (player.state === 'swinging') {
        releaseWeb();
    }
}

function resetGame() {
    gameState.running = true;
    gameState.score = 0;
    gameState.distance = 0;
    gameState.cameraX = 0;
    gameState.cameraY = 0;
    gameState.timeScale = 1.0;

    // Reset mobile climb hint
    player._shownClimbHint = false;
    player._climbHintTimer = 0;

    // Start ON the ground for the "Run up"
    let startGroundY = gameState.height - 150;

    player.x = 150;
    player.y = startGroundY - player.radius - 2; // On top
    player.vx = 6;  // Running start
    player.vy = 0;
    player.state = 'falling'; // Will become grounded immediately in loop
    player.anchor = null;
    player.grounded = true;
    player.hasSwung = false;

    buildings = [];
    anchors = [];
    particles = [];
    flock = [];

    // 1. Long start platform (RUNWAY)
    buildings.push({
        x: -200,
        y: gameState.height - 150,
        width: 2000,
        height: 200,
        type: 'ground'
    });
    // Add a specific, visible ad to the runway near the start
    let runwayAd = buildings[0];
    runwayAd.adIsTop = true; // Ensure it's on top before attaching
    attachAdToBuilding(runwayAd);
    runwayAd.adRelX = 600; // Force it to be near the start of the runway
    runwayAd.adRelY = -runwayAd.adHeight - 45;

    // Spawn birds on runway
    for (let j = 0; j < 5; j++) {
        flock.push({
            x: Math.random() * 800,
            y: gameState.height - 150,
            state: 'idle',
            vx: 0,
            vy: 0,
            frame: Math.floor(Math.random() * 10),
            timer: Math.random() * 10,
            facingLeft: Math.random() > 0.5,
            roofLeft: -200,
            roofRight: 1800,
            walkSpeed: 0.3 + Math.random() * 0.4,
            pauseTimer: Math.random() * 100
        });
    }

    // 2. The Drop - ADDED MORE ANCHORS HERE
    // Transition anchors
    anchors.push({ x: 800, y: 300, type: 'normal' });
    anchors.push({ x: 1200, y: 250, type: 'normal' });
    anchors.push({ x: 1600, y: 350, type: 'normal' });
    anchors.push({ x: 2100, y: 350, type: 'crane' });
    anchors.push({ x: 2400, y: 350, type: 'crane' });

    // 3. THE AMAZING CRANE RUN (Scripted Sequence)
    // "Aligned their cranes in a straight line"
    let craneStartX = 2800;
    let craneY = 250; // High but reachable
    let spacing = 700; // Wide spacing for speed

    for (let i = 0; i < 15; i++) {
        anchors.push({
            x: craneStartX + (i * spacing),
            y: craneY, // Perfectly aligned
            type: 'crane',
            alignment: 'aligned' // Special marker for visuals
        });

        // Add some "construction" context below?
        if (i % 2 === 0) {
            buildings.push({
                x: craneStartX + (i * spacing) - 100,
                y: gameState.height - 150,
                width: 200,
                height: 2000,
                type: 'building',
                color: `hsl(${210 + Math.random() * 20}, ${10 + Math.random() * 10}%, ${15 + Math.random() * 10}%)`,
                windowSeed: Math.random()
            });
            attachAdToBuilding(buildings[buildings.length - 1]); // Add ad to crane building

            // Spawn birds on these buildings
            let bLeft = craneStartX + (i * spacing) - 100;
            let bRight = bLeft + 200;
            let numBirds = 1 + Math.floor(Math.random() * 3);
            for (let j = 0; j < numBirds; j++) {
                flock.push({
                    x: bLeft + random(10, 190),
                    y: gameState.height - 150,
                    state: 'idle',
                    vx: 0,
                    vy: 0,
                    frame: Math.floor(Math.random() * 10),
                    timer: Math.random() * 10,
                    facingLeft: Math.random() > 0.5,
                    roofLeft: bLeft + 5,
                    roofRight: bRight - 5,
                    walkSpeed: 0.3 + Math.random() * 0.4,
                    pauseTimer: Math.random() * 100
                });
            }
        }
    }

    document.getElementById('game-over').style.display = 'none';
    document.getElementById('score').innerText = '0m';

    // Clear all existing ads
    const adLayer = document.getElementById('ad-layer');
    if (adLayer) adLayer.innerHTML = '';
    activeAdCount = 0;
    adLoadTimer = 0;
}

function resize() {
    let screenW = window.innerWidth;
    let screenH = window.innerHeight;
    let overlay = document.getElementById('ui-overlay');
    let adLayer = document.getElementById('ad-layer');

    // On mobile portrait: rotate canvas to force landscape gameplay
    if (isMobileDevice && screenH > screenW) {
        isPortrait = true;
        // Swap: game sees landscape dimensions
        gameState.width = screenH;
        gameState.height = screenW;
        // Canvas pixel buffer = landscape dimensions
        canvas.width = screenH;
        canvas.height = screenW;
        // CSS: fit to screen, then rotate
        canvas.style.width = screenH + 'px';
        canvas.style.height = screenW + 'px';
        canvas.style.position = 'absolute';
        canvas.style.transformOrigin = 'top left';
        canvas.style.transform = 'rotate(90deg) translateY(-100%)';
        canvas.style.top = '0';
        canvas.style.left = '0';
        // Rotate UI overlay to match
        if (overlay) {
            overlay.style.width = screenH + 'px';
            overlay.style.height = screenW + 'px';
            overlay.style.transformOrigin = 'top left';
            overlay.style.transform = 'rotate(90deg) translateY(-100%)';
        }
        // Rotate Ad Layer to match
        if (adLayer) {
            adLayer.style.width = screenH + 'px';
            adLayer.style.height = screenW + 'px';
            adLayer.style.transformOrigin = 'top left';
            adLayer.style.transform = 'rotate(90deg) translateY(-100%)';
        }
        // Sync FG Canvas
        fgCanvas.width = screenH;
        fgCanvas.height = screenW;
        fgCanvas.style.width = screenH + 'px';
        fgCanvas.style.height = screenW + 'px';
        fgCanvas.style.position = 'absolute';
        fgCanvas.style.transformOrigin = 'top left';
        fgCanvas.style.transform = 'rotate(90deg) translateY(-100%)';
        fgCanvas.style.top = '0';
        fgCanvas.style.left = '0';
        document.body.style.overflow = 'hidden';
    } else {
        isPortrait = false;
        gameState.width = screenW;
        gameState.height = screenH;
        canvas.width = screenW;
        canvas.height = screenH;
        fgCanvas.width = screenW;
        fgCanvas.height = screenH;
        // Reset any rotation styles
        canvas.style.width = '';
        canvas.style.height = '';
        canvas.style.position = '';
        canvas.style.transformOrigin = '';
        canvas.style.transform = '';
        canvas.style.top = '';
        canvas.style.left = '';

        fgCanvas.style.width = '';
        fgCanvas.style.height = '';
        fgCanvas.style.position = '';
        fgCanvas.style.transformOrigin = '';
        fgCanvas.style.transform = '';
        fgCanvas.style.top = '';
        fgCanvas.style.left = '';
        // Reset UI overlay
        if (overlay) {
            overlay.style.width = '';
            overlay.style.height = '';
            overlay.style.transformOrigin = '';
            overlay.style.transform = '';
        }
        // Reset Ad Layer
        if (adLayer) {
            adLayer.style.width = '';
            adLayer.style.height = '';
            adLayer.style.transformOrigin = '';
            adLayer.style.transform = '';
        }
    }
    updateMobileButtonLayout();
}

// --- Main Loop ---
let lastTime = 0;

function loop(timestamp) {
    if (!gameState.running) return;

    if (!lastTime) lastTime = timestamp;
    let delta = timestamp - lastTime;
    lastTime = timestamp;

    // Cap delta to prevent huge physics jumps if tab was inactive
    if (delta > 50) delta = 50;

    // Normalize dt to 60fps (approx 16.66ms per frame)
    let timeScale = delta / 16.666;

    update(timeScale);
    draw();
    requestAnimationFrame(loop);
}

function update(baseTimeScale = 1.0) {
    // Slomo Logic: Cinematic Matrix Style
    // Slow down whenever we are in the air (aiming/falling)
    // Speed up when running or swinging
    let dt = baseTimeScale;

    if (player.state === 'falling' && !player.grounded) {
        dt = baseTimeScale * 0.4; // 40% speed for dramatic air time & aiming
    }

    gameState.timeScale = dt;

    // 1. Camera Logic: Strict Player Follow
    // The screen moves WITH the person.
    // 1. Camera Logic: Character-Centric Visibility
    // We want the player to stay roughly at 30% of the screen horizontally
    // and centered vertically, but we allow more freedom.

    let targetCamX = player.x - gameState.width * 0.3;
    let targetCamY = player.y - gameState.height * 0.5;

    // Responsive Follow: The camera should move whenever the player moves.
    // Use a higher catchup speed for the camera to ensure visibility.
    let followSpeedX = 0.15;
    let followSpeedY = 0.1;

    gameState.cameraX += (targetCamX - gameState.cameraX) * followSpeedX * dt;
    gameState.cameraY += (targetCamY - gameState.cameraY) * followSpeedY * dt;

    // Cap Camera Downward Pan
    // Don't follow the player too far into the abyss
    if (gameState.cameraY > 200) gameState.cameraY = 200;

    // Absolute Clamp (Safety): If camera is too far, snap it.
    // This prevents the player from ever leaving the bounding box of the viewport.
    let margin = 50;
    if (player.x < gameState.cameraX + margin) gameState.cameraX = player.x - margin;
    if (player.x > gameState.cameraX + gameState.width - margin) gameState.cameraX = player.x - gameState.width + margin;
    if (player.y < gameState.cameraY + margin) gameState.cameraY = player.y - margin;
    if (player.y > gameState.cameraY + gameState.height - margin) gameState.cameraY = player.y - gameState.height + margin;

    // 1.5 Screen Shake
    if (gameState.shake > 0) {
        gameState.cameraX += (Math.random() - 0.5) * gameState.shake;
        gameState.cameraY += (Math.random() - 0.5) * gameState.shake;
        gameState.shake *= 0.9;
        if (gameState.shake < 0.1) gameState.shake = 0;
    }

    // 1.5 Dynamic Zoom (Simulation)
    // We adjust the viewport feel by nudging the camera Y and speed
    let speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    let zoomInfluence = Math.min(speed / 20, 1.0);
    // When going fast, pan the camera slightly further ahead 
    gameState.cameraX += player.vx * 0.2 * zoomInfluence * dt;

    // 2. Physics
    // Reset grounded flag (will be set in collision) - Wait, we need it for next frame's logic
    // We update logic based on CURRENT grounded state, then check collisions for NEXT state.
    // player.grounded currently holds state from LAST frame's collision check.

    // Mobile climb buttons: continuous climbing while held
    if (isMobile && player.state === 'swinging' && touchState.climbDirection !== 0) {
        let mobileClimbSpeed = 4.0 * dt;
        player.ropeLength += touchState.climbDirection * mobileClimbSpeed;
        if (player.ropeLength < CONFIG.webLengthMin) player.ropeLength = CONFIG.webLengthMin;
        if (player.ropeLength > CONFIG.webLengthMax) player.ropeLength = CONFIG.webLengthMax;
    }

    if (player.state === 'swinging') {
        updateSwing(dt);
    } else {
        updateFall(dt);
    }

    player.animTimer += 0.1 * dt; // Slow down animation too

    // 3. World
    generateWorld();
    cleanupWorld();

    // 3.5 Flock
    for (let i = flock.length - 1; i >= 0; i--) {
        let b = flock[i];

        if (b.state === 'idle') {
            b.timer += dt * 5;
            b.frame = Math.floor(b.timer * 0.1) % 6;

            // Walking behavior
            b.pauseTimer -= dt;
            if (b.pauseTimer <= 0) {
                // Walk in facing direction
                let walkDir = b.facingLeft ? -1 : 1;
                b.x += walkDir * b.walkSpeed * dt;

                // Turn around at roof edges
                if (b.x <= b.roofLeft) {
                    b.x = b.roofLeft;
                    b.facingLeft = false;
                    b.pauseTimer = 30 + Math.random() * 80; // Pause before walking back
                } else if (b.x >= b.roofRight) {
                    b.x = b.roofRight;
                    b.facingLeft = true;
                    b.pauseTimer = 30 + Math.random() * 80;
                }

                // Randomly stop and change direction sometimes
                if (Math.random() < 0.005) {
                    b.facingLeft = !b.facingLeft;
                    b.pauseTimer = 40 + Math.random() * 120;
                }
            }

            let dx = player.x - b.x;
            let dy = player.y - b.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            // Spook if player is near
            if (dist < 200 || (player.grounded && Math.abs(dx) < 400 && dy > -150 && dy < 150)) {
                b.state = 'flying';
                b.vx = (b.x > player.x ? 1 : -1) * random(2, 5);
                b.vy = -random(3, 6);
                b.frame = 0;
                b.facingLeft = b.vx < 0;
            }
        } else if (b.state === 'flying') {
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.vy += -0.15 * dt;

            b.timer += dt;
            b.frame = Math.floor(b.timer * 0.5) % sprites.bird.totalFrames;
        }

        if (b.x < gameState.cameraX - 500 || b.y < gameState.cameraY - 500) {
            flock.splice(i, 1);
        }
    }

    // VISUAL FLAIR MOMENT
    // Crane Run starts at 2800.
    if (player.x > 2600 && player.x < 2700) {
        // Flash / Shake?
        gameState.cameraY += (Math.random() - 0.5) * 10;
    }

    // Zoom out slightly for the grand view?
    // We simulate zoom by adjusting render scale? Too complex for 2D context.
    // Instead, we just pan the camera to frame it perfectly.

    // 4. Collisions
    player.grounded = false; // Assume air until hit
    checkCollisions(); // This sets player.grounded = true if hit
    checkDeath();

    // 5. Trails
    player.trails.push({ x: player.x, y: player.y });
    if (player.trails.length > 8) player.trails.shift();

    // 6. UI
    gameState.distance = Math.floor(player.x / 10);
    document.getElementById('score').innerText = gameState.distance + "m";

    // 7. Billboards
    updateBillboards(dt);
}

function updateFall(dt) {
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    player.vy += CONFIG.gravity * dt;

    // Air Strafe - subtle control
    if (input.active && !player.grounded) {
        player.vx += 0.05 * dt; // Slight forward push
    }

    if (player.vy > CONFIG.maxFallSpeed) player.vy = CONFIG.maxFallSpeed;

    // Friction
    player.vx *= (1 - (1 - CONFIG.airFriction) * dt);
}

function updateSwing(dt) {
    if (!player.anchor) {
        player.state = 'falling';
        return;
    }

    // Pendulum physics with Tension and Pumping
    let dx = player.x - player.anchor.x;
    let dy = player.y - player.anchor.y;
    let dist = Math.sqrt(dx * dx + dy * dy);

    // 1. Directional Vectors
    let nx = dx / dist; // Normal to anchor
    let ny = dy / dist;

    // 2. Tangential Vector (The direction of the swing)
    let tx = -ny;
    let ty = nx;

    // Ensure tangent points in direction of velocity
    let dot = player.vx * tx + player.vy * ty;
    if (dot < 0) {
        tx = -tx;
        ty = -ty;
    }

    // 3. Apply Forces
    // Gravity influence
    player.vy += CONFIG.gravity * dt;

    // Swing "Pump" - Add force in tangential direction if moving fast enough or input active
    if (input.active) {
        let pump = 0.2 * dt;
        player.vx += tx * pump;
        player.vy += ty * pump;
    }

    // 4. Move (Prediction)
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    // 5. Constrain to Rope (Verlet-style with Elasticity)
    let ndx = player.x - player.anchor.x;
    let ndy = player.y - player.anchor.y;
    let newDist = Math.sqrt(ndx * ndx + ndy * ndy);

    if (newDist > player.ropeLength) {
        // Tension kicks in
        let overshoot = newDist - player.ropeLength;

        // If grounded, we want to stay on the building but get pulled forward
        if (player.grounded) {
            // Only apply horizontal tension to speed up running
            let pullX = (ndx / newDist) * overshoot * 0.5;
            player.vx -= pullX; 
            
            // Limit vertical pull so we don't "hop" too much unless rope is very short
            if (ndy > 0) { // Anchor is above us
                 // Apply a tiny bit of upward force for "lightness" but keep grounded
                 player.y = player.anchor.y + Math.sqrt(player.ropeLength**2 - ndx**2); 
                 // Actually, simpler: just keep them on the roof if they are grounded
            }
        } else {
            // Standard air tension
            player.x -= (ndx / newDist) * overshoot * CONFIG.swingElasticity;
            player.y -= (ndy / newDist) * overshoot * CONFIG.swingElasticity;
        }

        // Recalculate Velocity (Conservation of momentum along tangent)
        let nndx = player.x - player.anchor.x;
        let nndy = player.y - player.anchor.y;
        let nDist = Math.sqrt(nndx * nndx + nndy * nndy);

        // New Velocity = Old Velocity projected onto the tangent
        let ntx = -nndy / nDist;
        let nty = nndx / nDist;

        let velDot = player.vx * ntx + player.vy * nty;
        player.vx = ntx * velDot;
        player.vy = nty * velDot;
        
        // Additional forward "Web Sprint" boost if grounded
        if (player.grounded && input.active) {
            player.vx += 0.2 * dt;
        }
    }

    // Air friction (slight)
    player.vx *= 0.999;
    player.vy *= 0.999;
}

function tryAttachWeb() {
    let best = null;
    let bestDist = Infinity;

    // Search area bias
    for (let a of anchors) {
        let dx = a.x - player.x;
        let dy = a.y - player.y;
        let d = Math.sqrt(dx * dx + dy * dy);

        if (d >= CONFIG.webLengthMin && d <= CONFIG.webLengthMax) {
            let score = d;
            if (dx < 0) score += 500;
            if (dy > 0) score += 200;

            // Prioritize Crane type slightly
            if (a.type === 'crane') score -= 50;

            if (score < bestDist) {
                bestDist = score;
                best = a;
            }
        }
    }

    if (best) {
        player.anchor = best;
        player.state = 'swinging';

        let dx = player.x - best.x;
        let dy = player.y - best.y;
        player.ropeLength = Math.sqrt(dx * dx + dy * dy);

        player.hasSwung = true; // End slomo

        playSound(sounds.thwip);
    }
}

function releaseWeb() {
    player.state = 'falling';
    if (player.anchor) {
        let speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
        if (speed > 10) gameState.shake = speed * 0.5; // Big release shake

        player.vx *= CONFIG.swingBoost;
        player.vy *= CONFIG.swingBoost;
    }
    player.anchor = null;
    player.hasSwung = true;

    stopSound(sounds.thwip);
}

function checkCollisions() {
    for (let b of buildings) {
        if (player.x + player.radius >= b.x &&
            player.x - player.radius <= b.x + b.width &&
            player.y + player.radius >= b.y &&
            player.y - player.radius <= b.y + b.height) {

            // Landing logic - checking if we are hitting the TOP of the building
            // We want to allow running on ANY building top
            // Condition: Falling (vy >= 0) AND mostly above the building
            let overlapY = (player.y + player.radius) - b.y;

            // "Top" collision tolerance: 
            // If the player's feet are within the top 25px of the building
            // AND the player was previously above this building (or falling into it)
            if (player.vy >= 0 && overlapY <= 30 && overlapY > -50) {
                // Land / Slide
                player.y = b.y - player.radius;
                player.vy = 0;
                player.grounded = true;

                if (player.state === 'swinging') releaseWeb();

                // Run friction layout
                player.vx *= CONFIG.groundFriction;

                // FORCE RUN MECHANIC
                // The player MUST run.
                if (player.vx < 6) player.vx = 6;

                // Cap max run speed so it doesn't get crazy
                if (player.vx > 12) player.vx = 12;
            } else {
                // Hitting the side or bottom -> Crash
                gameOver();
            }
        }
    }
}

function checkDeath() {
    // Fail if falling too far below the city level
    // The runway starts at gameState.height - 150. 
    // Let's set a "Deadly Void" slightly below that (e.g. + 200px)
    let deathLimit = gameState.height + 150;

    if (player.y > deathLimit) {
        gameOver();
    }
}

function gameOver() {
    gameState.running = false;
    document.getElementById('final-score').innerText = "Distance: " + gameState.distance + "m";
    document.getElementById('game-over').style.display = 'block';
}

// --- World Gen ---
function generateWorld() {
    let genX = gameState.cameraX + gameState.width * 2;

    let lastX = -200;
    if (buildings.length > 0) lastX = buildings[buildings.length - 1].x + buildings[buildings.length - 1].width;

    let lastAnchorX = 200;
    if (anchors.length > 0) lastAnchorX = anchors[anchors.length - 1].x;

    // Buildings
    if (lastX < genX) {
        // Random spacing with a defined minimum gap
        let minGap = 150;
        let maxGap = 500;
        let gap = random(minGap, maxGap);

        let w = random(250, 700); // Random widths
        let y = gameState.height - random(100, 400); // Variety in height positions
        if (Math.random() > 0.7) y += random(50, 150); // Some lower buildings

        // TIERED BUILDING DATA
        let hasTier = Math.random() > 0.5;
        let tierWidth = w * (0.6 + Math.random() * 0.3);

        buildings.push({
            x: lastX + gap,
            y: y,
            width: w,
            height: 2000,
            type: Math.random() > 0.3 ? 'building' : (Math.random() > 0.5 ? 'skascraper' : 'industrial'),
            color: `hsl(${200 + Math.random() * 40}, ${5 + Math.random() * 15}%, ${10 + Math.random() * 15}%)`,
            windowSeed: Math.random(),
            hasNeon: Math.random() > 0.8,
            neonColor: `hsl(${Math.random() * 360}, 100%, 60%)`,
            hasTier: hasTier,
            tierWidth: tierWidth,
            tierHeight: 100 + Math.random() * 200,
            hasAd: false
        });

        let b = buildings[buildings.length - 1];
        attachAdToBuilding(b);

        let numBirds = 1 + Math.floor(Math.random() * 4); // Ensure at least 1 bird per building
        for (let j = 0; j < numBirds; j++) {
            let onTier = b.hasTier && Math.random() > 0.5;
            let bx, by;
            if (onTier) {
                let tx = b.x + (b.width - b.tierWidth) / 2;
                bx = tx + random(10, b.tierWidth - 10);
                by = b.y - b.tierHeight;
            } else {
                bx = b.x + random(10, b.width - 10);
                by = b.y;
            }
            let rLeft, rRight;
            if (onTier) {
                rLeft = b.x + (b.width - b.tierWidth) / 2 + 5;
                rRight = rLeft + b.tierWidth - 10;
            } else {
                rLeft = b.x + 5;
                rRight = b.x + b.width - 5;
            }
            flock.push({
                x: bx,
                y: by,
                state: 'idle',
                vx: 0,
                vy: 0,
                frame: Math.floor(Math.random() * 10),
                timer: Math.random() * 10,
                facingLeft: Math.random() > 0.5,
                roofLeft: rLeft,
                roofRight: rRight,
                walkSpeed: 0.3 + Math.random() * 0.4,
                pauseTimer: Math.random() * 100
            });
        }
    }

    // Anchors
    if (lastAnchorX < genX) {
        let patternChance = Math.random();

        if (patternChance < 0.25) { // 25% Crane Run
            let sequenceCount = Math.floor(random(3, 6));
            let startX = lastAnchorX + 350; // RULE: Start closer to last anchor
            let spacing = 400;              // RULE: Max web length is 500, spacing must be < 450
            let height = random(200, 300);  // RULE: Safe height, never near the ground

            for (let i = 0; i < sequenceCount; i++) {
                anchors.push({
                    x: startX + (i * spacing),
                    y: height + random(-20, 20), // Slight natural variation
                    type: 'crane'
                });
            }
        }
        else {
            let gap = random(250, 450); // RULE: Gap must be smaller than webLengthMax (500)
            let y = random(100, 350);   // RULE: Must be high enough to complete a swing arc without hitting the ground
            anchors.push({
                x: lastAnchorX + gap,
                y: y,
                type: 'normal'
            });
        }
    }
}

function cleanupWorld() {
    let limit = gameState.cameraX - 500;
    
    // Remove ads from DOM before filtering buildings
    for (let b of buildings) {
        if (b.x + b.width < limit && b.adElement) {
            if (b.adLoaded) activeAdCount--;
            b.adElement.remove();
            b.adElement = null;
        }
    }

    buildings = buildings.filter(b => b.x + b.width > limit);
    anchors = anchors.filter(a => a.x > limit);
}

function attachAdToBuilding(b) {
    if (b.hasAd) return; // Already has one

    b.hasAd = true;
    b.adLoaded = false;
    
    // Pick a random template
    const template = AD_TEMPLATES[Math.floor(Math.random() * AD_TEMPLATES.length)];
    b.adConfig = template;

    // Smart logic: tall ads go on sides, wide ads go on top
    if (template.type.startsWith('wide') || template.type === 'mobile' || template.type === 'square') {
        b.adIsTop = Math.random() > 0.4; // Slightly favor top for wide
    } else {
        b.adIsTop = false; // Tall ads always on side
    }

    if (b.adIsTop) {
        b.adWidth = template.width;
        b.adHeight = template.height;
        b.adRelX = random(0, Math.max(1, b.width - b.adWidth));
        b.adRelY = -b.adHeight - 45;
    } else {
        b.adWidth = template.width;
        b.adHeight = template.height;
        b.adRelX = (b.width > b.adWidth) ? random(10, b.width - b.adWidth - 10) : (b.width - b.adWidth)/2;
        b.adRelY = random(10, 80);
    }

    // Create the DOM element
    const adEl = document.createElement('div');
    adEl.className = 'billboard-ad' + (b.adIsTop ? ' on-top' : '');
    adEl.style.width = b.adWidth + 'px';
    adEl.style.height = b.adHeight + 'px';
    adEl.innerHTML = `<div class="ad-placeholder">CONNECTING...</div>`;

    document.getElementById('ad-layer').appendChild(adEl);
    b.adElement = adEl;
}

function injectAdScript(b) {
    if (!b.adElement || b.adLoaded || activeAdCount >= AD_SETTINGS.maxActiveAds) return;

    b.adLoaded = true;
    activeAdCount++;
    b.adElement.innerHTML = ''; 

    const config = b.adConfig;

    const script1 = document.createElement('script');
    script1.type = 'text/javascript';
    script1.innerHTML = `
        atOptions = {
            'key' : '${config.key}',
            'format' : 'iframe',
            'height' : ${config.height},
            'width' : ${config.width},
            'params' : {}
        };
    `;
    b.adElement.appendChild(script1);

    const script2 = document.createElement('script');
    script2.type = 'text/javascript';
    script2.src = `https://www.highperformanceformat.com/${config.key}/invoke.js`;
    b.adElement.appendChild(script2);
}

function updateBillboards(dt = 1) {
    // 1. Process Ad Loading Queue
    adLoadTimer += dt * 16.66; // Approx ms
    if (adLoadTimer > AD_SETTINGS.loadInterval) {
        adLoadTimer = 0;
        
        // Find the best visible building to load an ad for (prioritize right-most/newest)
        let bestCandidate = null;
        let maxX = -Infinity;

        for (let b of buildings) {
            if (b.hasAd && !b.adLoaded) {
                let screenX = b.x - gameState.cameraX;
                // Pick buildings that are on screen, favoring the ones on the right
                if (screenX > -100 && screenX < gameState.width + 200 && screenX > maxX) {
                    maxX = screenX;
                    bestCandidate = b;
                }
            }
        }

        if (bestCandidate) {
            injectAdScript(bestCandidate);
        }
    }

    // 2. Position and Cull
    for (let b of buildings) {
        if (b.hasAd && b.adElement) {
            let screenX = b.x + b.adRelX - gameState.cameraX;
            let screenY = b.y + b.adRelY - gameState.cameraY;

            // Simple culling
            if (screenX + b.adWidth < -300 || screenX > gameState.width + 300) {
                b.adElement.style.display = 'none';
            } else {
                b.adElement.style.display = 'flex';
                b.adElement.style.transform = `translate(${screenX}px, ${screenY}px)`;
            }
        }
    }
}

function drawCrane(ctx, anchorX, anchorY, isAligned) {
    // A crane's anchor point is the hook. 
    // We position the tower relative to the hook.
    const towerX = anchorX - 250; 
    const towerTopY = anchorY - 120;
    const craneColor = '#f39c12'; // Vibrant construction orange/yellow
    const steelColor = '#2c3e50'; // Dark steel blue/grey
    const detailColor = '#d35400'; // Darker orange for shadows/accents

    ctx.save();
    
    // 1. MAIN TOWER (Mast)
    // Draw the vertical tower structure with lattice
    ctx.strokeStyle = craneColor;
    ctx.lineWidth = 14;
    ctx.lineCap = 'butt';
    
    // Main vertical rails
    ctx.beginPath();
    ctx.moveTo(towerX - 10, gameState.height + 1000);
    ctx.lineTo(towerX - 10, towerTopY);
    ctx.moveTo(towerX + 10, gameState.height + 1000);
    ctx.lineTo(towerX + 10, towerTopY);
    ctx.stroke();

    // Lattice (X-bracing) on tower
    ctx.lineWidth = 2;
    ctx.strokeStyle = detailColor;
    for (let h = towerTopY; h < gameState.height + 500; h += 40) {
        ctx.beginPath();
        ctx.moveTo(towerX - 10, h);
        ctx.lineTo(towerX + 10, h + 20);
        ctx.moveTo(towerX + 10, h);
        ctx.lineTo(towerX - 10, h + 20);
        ctx.stroke();
        // Horizontal separators
        ctx.beginPath();
        ctx.moveTo(towerX - 10, h);
        ctx.lineTo(towerX + 10, h);
        ctx.stroke();
    }

    // 2. THE CAB (Cabin)
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(towerX - 18, towerTopY - 45, 36, 45);
    ctx.strokeStyle = craneColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(towerX - 18, towerTopY - 45, 36, 45);
    
    // Cab Window
    ctx.fillStyle = 'rgba(100, 220, 255, 0.4)';
    ctx.fillRect(towerX - 12, towerTopY - 38, 24, 18);

    // 3. THE JIB (Horizontal Arm)
    let jibEndAngle = isAligned ? 0 : -0.05; // Slightly slanted if not aligned
    let jibLen = 500;
    let counterJibLen = 120;

    ctx.save();
    ctx.translate(towerX, towerTopY - 20);
    ctx.rotate(jibEndAngle);

    // Main horizontal rails
    ctx.strokeStyle = craneColor;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-counterJibLen, -15);
    ctx.lineTo(jibLen, -10);
    ctx.moveTo(-counterJibLen, 15);
    ctx.lineTo(jibLen, 10);
    ctx.stroke();

    // Jib Lattice (Truss)
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = detailColor;
    for (let x = -counterJibLen; x < jibLen; x += 35) {
        ctx.beginPath();
        ctx.moveTo(x, -15);
        ctx.lineTo(x + 17, 12);
        ctx.lineTo(x + 35, -15);
        ctx.stroke();
        // Verticals
        ctx.beginPath();
        ctx.moveTo(x, -15);
        ctx.lineTo(x, 15);
        ctx.stroke();
    }

    // Counterweight
    ctx.fillStyle = '#444';
    ctx.fillRect(-110, -5, 60, 30);
    ctx.strokeStyle = '#222';
    ctx.strokeRect(-110, -5, 60, 30);

    // 4. THE TROLLEY & CABLE (Connecting to anchor point)
    // The anchorX is relative to the world, we need it relative to towerX
    let trolleyX = anchorX - towerX;
    
    ctx.fillStyle = '#222';
    ctx.fillRect(trolleyX - 12, 10, 24, 12);
    
    // Cable hanging down
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(trolleyX, 15);
    ctx.lineTo(trolleyX, (anchorY - (towerTopY - 20))); // Connect to the actual anchorY
    ctx.stroke();

    // The Hook
    ctx.save();
    ctx.translate(trolleyX, anchorY - (towerTopY - 20));
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 5, 6, -Math.PI/2, Math.PI);
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // End Jib transform

    // 5. FLASHING WARNING LIGHTS
    let isOn = (Math.floor(Date.now() / 600) % 2 === 0);
    if (isOn) {
        ctx.fillStyle = '#ff0000';
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#ff0000';
        
        // Top light
        ctx.beginPath();
        ctx.arc(towerX, towerTopY - 55, 5, 0, Math.PI * 2);
        ctx.fill();

        // Tip light
        let tipX = towerX + Math.cos(jibEndAngle) * jibLen;
        let tipY = (towerTopY - 20) + Math.sin(jibEndAngle) * jibLen;
        ctx.beginPath();
        ctx.arc(tipX, tipY - 10, 4, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.shadowBlur = 0;
    }

    ctx.restore();
}

// --- Draw ---
function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fgCtx.clearRect(0, 0, fgCanvas.width, fgCanvas.height);

    // BACKGROUND CONTEXT (ctx) - Sky, Stars, Far City
    // Background Sky Gradient
    let skyGrad = ctx.createLinearGradient(0, 0, 0, gameState.height);
    skyGrad.addColorStop(0, '#050508');
    skyGrad.addColorStop(1, '#111118');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, gameState.width, gameState.height);

    // 0. CELESTIALS
    let altitudeThreshold = -200;
    let fullVisibilityHeight = -800;
    let altitudeFactor = clamp((gameState.cameraY - altitudeThreshold) / (fullVisibilityHeight - altitudeThreshold), 0, 1);

    if (altitudeFactor > 0) {
        ctx.save();
        ctx.globalAlpha = altitudeFactor;

        // 1. Twinkling Stars
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 50; i++) {
            let sx = (i * 137.5) % gameState.width;
            let sy = (i * 251.3) % (gameState.height * 0.6);
            let twink = Math.sin(gameState.distance * 0.05 + i) * 0.5 + 0.5;
            ctx.beginPath();
            ctx.arc(sx, sy, 0.5 + twink, 0, Math.PI * 2);
            ctx.fill();
        }

        // 2. THE MOON
        let moonScale = 0.5 + Math.pow(altitudeFactor, 3) * 6;
        let moonX = gameState.width * 0.7 - (altitudeFactor * (gameState.width * 0.2));
        let moonY = -500 + (altitudeFactor * 750);

        ctx.save();
        ctx.translate(moonX, moonY);
        ctx.scale(moonScale, moonScale);
        let glowSize = 100 + altitudeFactor * 100;
        let moonGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowSize);
        moonGlow.addColorStop(0, `rgba(255, 255, 255, ${0.1 + altitudeFactor * 0.2})`);
        moonGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = moonGlow;
        ctx.beginPath(); ctx.arc(0, 0, glowSize, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f0f0f0';
        ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#e0e0e0';
        ctx.beginPath();
        ctx.arc(-20, -10, 15, 0, Math.PI * 2);
        ctx.arc(15, 20, 10, 0, Math.PI * 2);
        ctx.arc(10, -25, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (altitudeFactor > 0.8) {
            ctx.fillStyle = `rgba(255, 255, 255, ${(altitudeFactor - 0.8) * 0.5})`;
            ctx.fillRect(0, 0, gameState.width, gameState.height);
        }
        ctx.restore();
    }

    // Parallax City Layers
    ctx.save();
    let pX = -(gameState.cameraX * 0.1) % 1500;
    let pY = -(gameState.cameraY * 0.05) + 200;
    ctx.translate(pX, pY);
    ctx.fillStyle = '#08080a';
    for (let i = -1; i < 3; i++) {
        let off = i * 1500;
        ctx.fillRect(off + 100, gameState.height - 600, 200, 800);
        ctx.fillRect(off + 400, gameState.height - 800, 300, 1000);
        ctx.fillRect(off + 900, gameState.height - 500, 150, 700);
    }
    ctx.restore();

    ctx.save();
    let pX2 = -(gameState.cameraX * 0.25) % 1500;
    let pY2 = -(gameState.cameraY * 0.1) + 150;
    ctx.translate(pX2, pY2);
    ctx.fillStyle = '#101015';
    for (let i = -1; i < 3; i++) {
        let off = i * 1500;
        ctx.fillRect(off + 50, gameState.height - 400, 100, 600);
        ctx.fillRect(off + 600, gameState.height - 550, 240, 800);
        ctx.fillRect(off + 1100, gameState.height - 350, 180, 500);
    }
    ctx.restore();

    ctx.save();
    ctx.translate(-gameState.cameraX, -gameState.cameraY);

    // Cranes
    for (let a of anchors) {
        if (a.type === 'crane') {
            drawCrane(ctx, a.x, a.y, a.alignment === 'aligned');
        }
    }

    // Buildings
    for (let b of buildings) {
        // --- Building Body (Classic Old Brick) ---
        let bGrad = ctx.createLinearGradient(0, b.y, 0, b.y + 800);
        // Brick-themed color palette (Weathered Red/Brown/Tan)
        let brickColors = ['#8b4513', '#a52a2a', '#7b3f00', '#5c4033', '#800000'];
        let seed = b.windowSeed || Math.random(); // Fallback if seed is missing
        let baseColor = brickColors[Math.floor(seed * brickColors.length)] || brickColors[0];
        
        bGrad.addColorStop(0, baseColor);
        bGrad.addColorStop(1, '#1a0d0a'); // Darker bottom
        ctx.fillStyle = bGrad;
        ctx.fillRect(b.x, b.y, b.width, b.height);

        // --- Repeating Brick Pattern ---
        ctx.save();
        ctx.globalAlpha = 0.2; // Subtle texture
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 0.5;
        let brickW = 20;
        let brickH = 10;
        
        // Only draw bricks in visible areas
        for (let by = b.y; by < b.y + b.height; by += brickH) {
            if (by > gameState.cameraY + gameState.height || by + brickH < gameState.cameraY) continue;
            let offset = (Math.floor(by / brickH) % 2 === 0) ? 0 : brickW / 2;
            for (let bx = b.x; bx < b.x + b.width; bx += brickW) {
                ctx.strokeRect(bx + offset, by, brickW, brickH);
            }
        }
        ctx.restore();

        // --- Detailed Rooftop Cap (Inspired by tiled/brick ledge) ---
        let roofX = b.x;
        let roofY = b.y;
        let roofW = b.width;
        if (b.hasTier) {
            roofX = b.x + (b.width - b.tierWidth) / 2;
            roofY = b.y - b.tierHeight;
            roofW = b.tierWidth;
            ctx.fillRect(roofX, roofY, roofW, b.tierHeight);
        }

        // 1. The Tiled Plane (Light Tan/Pink)
        ctx.fillStyle = '#d9b8a8'; // Sandy/Tan tile color
        ctx.fillRect(roofX - 4, roofY - 10, roofW + 8, 12);
        
        // Tile highlights and depth
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(roofX - 4, roofY - 10);
        ctx.lineTo(roofX + roofW + 4, roofY - 10);
        ctx.stroke();

        // Vertical tile divisions
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        for (let tx = roofX - 4; tx < roofX + roofW + 4; tx += 40) {
            ctx.beginPath();
            ctx.moveTo(tx, roofY - 10);
            ctx.lineTo(tx + 5, roofY + 2); // Slight slant for perspective
            ctx.stroke();
        }

        ctx.fillStyle = bGrad; // Reset for potential inner logic

        // Roof Styles
        let roofType = Math.floor((b.windowSeed * 100) % 5);
        if (roofType === 0) {
            ctx.strokeStyle = '#333'; ctx.lineWidth = 3;
            let numAntennas = 1 + Math.floor((b.windowSeed * 10) % 3);
            for (let i = 0; i < numAntennas; i++) {
                let ax = roofX + (roofW * (0.1 + (i * 0.3) + (b.windowSeed * 0.1) % 0.2));
                let aHeight = 30 + ((b.windowSeed * (i + 1) * 40) % 60);
                ctx.beginPath(); ctx.moveTo(ax, roofY - 10); ctx.lineTo(ax, roofY - 10 - aHeight); ctx.stroke();
            }
        } else if (roofType === 1) {
            let numBoxes = 1 + Math.floor((b.windowSeed * 10) % 4);
            for (let i = 0; i < numBoxes; i++) {
                let bx = roofX + (roofW * ((i * 0.25) + (b.windowSeed * 0.1) % 0.1));
                let bw = 20 + ((b.windowSeed * (i + 1) * 20) % 30);
                let bh = 15 + ((b.windowSeed * (i + 2) * 20) % 40);
                if (bx + bw < roofX + roofW) {
                    ctx.fillRect(bx, roofY - 10 - bh, bw, bh);
                }
            }
        } else if (roofType === 2) {
            let slantDir = b.windowSeed > 0.5 ? 1 : -1;
            ctx.beginPath();
            if (slantDir === 1) { ctx.moveTo(roofX, roofY - 10); ctx.lineTo(roofX + roofW, roofY - 10); ctx.lineTo(roofX + roofW, roofY - 10 - 50 - ((b.windowSeed * 100) % 60)); }
            else { ctx.moveTo(roofX, roofY - 10); ctx.lineTo(roofX + roofW, roofY - 10); ctx.lineTo(roofX, roofY - 10 - 50 - ((b.windowSeed * 100) % 60)); }
            ctx.closePath(); ctx.fill();
        } else if (roofType === 3 && roofW > 80) {
            let domeRadius = Math.min(roofW * 0.35, 70);
            let domeX = roofX + roofW / 2;
            ctx.beginPath(); ctx.arc(domeX, roofY - 10, domeRadius, Math.PI, 0); ctx.fill();
            ctx.strokeStyle = '#333'; ctx.lineWidth = 4;
            ctx.beginPath(); ctx.moveTo(domeX, roofY - 10 - domeRadius); ctx.lineTo(domeX, roofY - 10 - domeRadius - 60); ctx.stroke();
        }

        // Window Helper
        function drawWindowsInternal(x, y, w, h, seed) {
            let winStepX = 35; let winStepY = 45; let winW = 14; let winH = 20; let padding = 20;
            let centerX = gameState.cameraX + gameState.width / 2;
            for (let wx = x + padding; wx < x + w - padding; wx += winStepX) {
                for (let wy = y + padding; wy < y + h - padding; wy += winStepY) {
                    if (wy + winH < gameState.cameraY || wy > gameState.cameraY + gameState.height) continue;
                    let winID = (wx * 1.3 + wy * 0.7 + seed * 1000) % 10;
                    let isLit = winID < 2.0;
                    ctx.fillStyle = isLit ? 'rgba(40, 40, 50, 1)' : 'rgba(0, 0, 0, 0.6)';
                    ctx.fillRect(wx, wy, winW, winH);
                    let relX = (wx - centerX) * 0.05;
                    let relY = (wy - (gameState.cameraY + gameState.height / 2)) * 0.05;
                    if (isLit) {
                        ctx.fillStyle = winID < 1.0 ? '#222233' : '#332222';
                        ctx.fillRect(wx + relX + 2, wy + relY + 2, winW - 4, winH - 4);
                    }
                    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.strokeRect(wx, wy, winW, winH);
                }
            }
        }
        drawWindowsInternal(b.x, b.y, b.width, 400, b.windowSeed);
        if (b.hasTier) drawWindowsInternal(b.x + (b.width - b.tierWidth) / 2, b.y - b.tierHeight, b.tierWidth, b.tierHeight, b.windowSeed + 0.1);

        if (b.hasNeon) {
            ctx.fillStyle = b.neonColor; ctx.shadowBlur = 20; ctx.shadowColor = b.neonColor;
            ctx.fillRect(b.x + 20, b.y + 100, b.width - 40, 60);
            ctx.shadowBlur = 0; ctx.fillStyle = '#000'; ctx.font = 'bold 24px Outfit'; ctx.textAlign = 'center';
            ctx.fillText("UPPER WEST", b.x + b.width / 2, b.y + 140);
        }
    }

    // Birds
    if (sprites.bird.loaded) {
        let frameW = sprites.bird.img.width / sprites.bird.cols;
        let frameH = sprites.bird.img.height / sprites.bird.rows;
        let drawW = 32; let drawH = 32;
        for (let b of flock) {
            ctx.save(); ctx.translate(b.x, b.y);
            if (b.facingLeft) ctx.scale(-1, 1);
            let col = b.frame % sprites.bird.cols;
            let row = Math.floor(b.frame / sprites.bird.cols);
            ctx.drawImage(sprites.bird.img, col * frameW, row * frameH, frameW, frameH, -drawW / 2, -drawH, drawW, drawH);
            ctx.restore();
        }
    }

    // Fog
    let fogGrad = ctx.createLinearGradient(0, gameState.cameraY + gameState.height - 200, 0, gameState.cameraY + gameState.height);
    fogGrad.addColorStop(0, 'rgba(5, 5, 8, 0)');
    fogGrad.addColorStop(1, 'rgba(5, 5, 8, 1)');
    ctx.fillStyle = fogGrad;
    ctx.fillRect(gameState.cameraX, gameState.cameraY + gameState.height - 200, gameState.width, 200);

    // Anchors
    let pulse = Math.sin(gameState.distance * 0.1) * 3;
    for (let a of anchors) {
        let isCrane = a.type === 'crane';
        ctx.fillStyle = isCrane ? 'rgba(255, 50, 50, 0.4)' : 'rgba(255, 255, 255, 0.3)';
        ctx.beginPath(); ctx.arc(a.x, a.y, isCrane ? 12 + pulse : 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = isCrane ? '#ff3333' : '#cccccc';
        ctx.beginPath(); ctx.arc(a.x, a.y, isCrane ? 4 : 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();


    // FOREGROUND CONTEXT (fgCtx) - Player, Web, Particles, UI
    fgCtx.save();
    fgCtx.translate(-gameState.cameraX, -gameState.cameraY);

    // Particles
    for (let p of particles) {
        fgCtx.fillStyle = p.color || '#fff';
        fgCtx.globalAlpha = p.life / 30;
        fgCtx.beginPath();
        if (p.type === 'input_ripple') {
            fgCtx.strokeStyle = '#fff';
            fgCtx.lineWidth = 2;
            fgCtx.arc(p.x, p.y, (20 - p.life) * 5, 0, Math.PI * 2);
            fgCtx.stroke();
        } else {
            fgCtx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            fgCtx.fill();
        }
    }

    // Anchor Hints
    for (let a of anchors) {
        let dx = a.x - player.x;
        let dy = a.y - player.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        let inRange = dist >= CONFIG.webLengthMin && dist <= CONFIG.webLengthMax;
        if (inRange && dx > -100) {
            fgCtx.strokeStyle = '#fff'; fgCtx.lineWidth = 2;
            fgCtx.beginPath(); fgCtx.arc(a.x, a.y, a.type === 'crane' ? 10 : 8, 0, Math.PI * 2); fgCtx.stroke();
            if (player.state !== 'swinging') {
                fgCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; fgCtx.lineWidth = 2; fgCtx.setLineDash([5, 5]);
                fgCtx.beginPath();
                let ddx = a.x - player.x; let ddy = a.y - player.y; let ddist = Math.sqrt(ddx * ddx + ddy * ddy);
                fgCtx.moveTo(player.x + (ddx / ddist) * 20, player.y + (ddy / ddist) * 20);
                fgCtx.lineTo(a.x, a.y); fgCtx.stroke(); fgCtx.setLineDash([]);
            }
        }
    }

    // Web Line
    if (player.state === 'swinging' && player.anchor) {
        fgCtx.save();
        let wdx = player.anchor.x - player.x;
        let wdy = player.anchor.y - player.y;
        let wdist = Math.sqrt(wdx * wdx + wdy * wdy);
        let numStrands = player.grounded ? 2 : 1;
        for (let i = 0; i < numStrands; i++) {
            let offsetSide = (i - (numStrands - 1) / 2) * 10;
            fgCtx.strokeStyle = '#e0e0e0'; fgCtx.lineWidth = player.grounded ? 2 : 3;
            fgCtx.beginPath();
            let origin = { x: player.x + (wdx / wdist) * 20, y: player.y + (wdy / wdist) * 20 };
            if (player.grounded) origin.y += offsetSide;
            let sdx = player.anchor.x - origin.x; let sdy = player.anchor.y - origin.y;
            let cp1x = origin.x + sdx * 0.33; let cp1y = origin.y + sdy * 0.33;
            let cp2x = origin.x + sdx * 0.66; let cp2y = origin.y + sdy * 0.66;
            let slack = player.ropeLength - wdist;
            if (slack > 0 && !player.grounded) {
                let curveStrength = Math.min(slack * 0.3, 20);
                let p_len = Math.sqrt(sdx * sdx + sdy * sdy);
                let px = -sdy / p_len; let py = sdx / p_len;
                let whipDir = player.vx > 0 ? 1 : -1;
                cp1x += px * curveStrength * whipDir; cp1y += py * curveStrength * whipDir;
                cp2x -= px * curveStrength * whipDir; cp2y -= py * curveStrength * whipDir;
                cp1y += curveStrength * 0.5; cp2y += curveStrength * 0.5;
            } else if (player.grounded) {
                let vib = Math.sin(Date.now() * 0.05) * 2; cp1y += vib; cp2y -= vib;
            }
            fgCtx.moveTo(origin.x, origin.y);
            fgCtx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, player.anchor.x, player.anchor.y);
            fgCtx.stroke();
            fgCtx.strokeStyle = '#ffffff'; fgCtx.lineWidth = 1; fgCtx.stroke();
        }
        fgCtx.restore();

        // Anchor impact splash
        if (Math.random() > 0.5) {
            particles.push({
                x: player.anchor.x,
                y: player.anchor.y,
                vx: (Math.random() - 0.5) * 5,
                vy: (Math.random() - 0.5) * 5,
                life: 30,
                color: Math.random() > 0.5 ? '#ffffff' : '#cccccc'
            });
        }
    }

    // Trails
    fgCtx.lineWidth = 15;
    for (let i = 0; i < player.trails.length; i++) {
        let t = player.trails[i];
        let alpha = (i / player.trails.length) * 0.15;
        fgCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        fgCtx.beginPath(); fgCtx.arc(t.x, t.y, player.radius * (i / player.trails.length), 0, Math.PI * 2); fgCtx.fill();
    }

    // Final Player Drawing
    drawPlayerOnCtx(fgCtx);
    fgCtx.restore();

    // Tutorial Text on FG context (Screen Space)
    fgCtx.save();
    fgCtx.font = '800 24px Outfit, sans-serif'; // Switched to Outfit for consistency
    fgCtx.textAlign = 'center';
    fgCtx.textBaseline = 'middle';
    let text = "";
    if (player.x < 1000) text = "BUILDING SPEED...";
    else if (player.x < 1700) text = "GET READY...";
    else if (player.x < 2200 && !player.hasSwung) { text = isMobile ? "TAP & HOLD TO SWING!" : "HOLD SPACE / CLICK TO SWING!"; fgCtx.fillStyle = '#ff3333'; }
    else if (player.x > 2600 && player.x < 3500) { text = "QUEUE THE MUSIC!"; fgCtx.font = 'italic 800 32px Outfit, sans-serif'; fgCtx.fillStyle = '#ffff00'; }
    if (text) {
        fgCtx.shadowColor = 'rgba(0,0,0,0.8)';
        fgCtx.shadowBlur = 10;
        fgCtx.fillText(text, gameState.width / 2, gameState.height * 0.3);
    }
    fgCtx.restore();

    if (isMobile) drawMobileHUD();
}

function drawPlayerOnCtx(targetCtx) {
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';

    let targetAngle = 0;
    if (player.state === 'swinging' && player.anchor) {
        let dx = player.x - player.anchor.x;
        let dy = player.y - player.anchor.y;
        targetAngle = Math.atan2(dy, dx) - Math.PI / 2;
    } else {
        targetAngle = Math.atan2(player.vy, player.vx * 1.5) / 1.5;
        targetAngle = clamp(targetAngle, -0.6, 0.6);
    }

    targetCtx.save();
    targetCtx.translate(player.x, player.y);
    targetCtx.rotate(targetAngle);

    let speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
    let currentSprite = null;
    let frameIndex = 0;

    // Choose sprite based on state
    if (player.state === 'swinging') {
        currentSprite = sprites.swing;
        frameIndex = Math.floor(player.animTimer * 8) % currentSprite.totalFrames;
    } else if (player.grounded) {
        currentSprite = sprites.run;
        frameIndex = Math.floor(player.animTimer * speed * 0.4) % currentSprite.totalFrames;
    } else {
        // Airborne/Falling
        currentSprite = sprites.swing;
        frameIndex = Math.floor(player.animTimer * 5) % currentSprite.totalFrames;
    }

    if (currentSprite && currentSprite.loaded) {
        let frameWidth = currentSprite.img.width / currentSprite.cols;
        let frameHeight = currentSprite.img.height / currentSprite.rows;
        let col = frameIndex % currentSprite.cols;
        let row = Math.floor(frameIndex / currentSprite.cols);

        let drawW = 64;
        let drawH = 64;
        let dx = -drawW / 2;
        let dy = -drawH / 2;

        if (currentSprite === sprites.run) {
            dy = player.radius - (drawH * 0.95);
        }

        targetCtx.drawImage(
            currentSprite.img,
            col * frameWidth, row * frameHeight, frameWidth, frameHeight,
            dx, dy, drawW, drawH
        );
        
        targetCtx.globalCompositeOperation = 'source-over';
    } else {
        // Fallback
        targetCtx.fillStyle = '#ff00ff';
        targetCtx.beginPath();
        targetCtx.arc(0, 0, player.radius, 0, Math.PI * 2);
        targetCtx.fill();
    }
    targetCtx.restore();
}

function drawMobileHUD() {
    let showClimb = player.state === 'swinging';
    let btnSize = touchState.btnSize;
    let r = btnSize * 0.4;
    let upAlpha = showClimb ? (touchState.climbUpActive ? 0.8 : 0.35) : 0.1;
    let upX = touchState.btnUpX;
    let upY = touchState.btnUpY;
    fgCtx.save();
    fgCtx.globalAlpha = upAlpha;
    fgCtx.fillStyle = touchState.climbUpActive ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.1)';
    fgCtx.beginPath(); fgCtx.roundRect(upX, upY, btnSize, btnSize, r); fgCtx.fill();
    fgCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)'; fgCtx.lineWidth = 1.5; fgCtx.stroke();
    fgCtx.fillStyle = '#fff'; fgCtx.beginPath();
    let cx = upX + btnSize / 2; let cy = upY + btnSize / 2; let arrowSize = btnSize * 0.25;
    fgCtx.moveTo(cx, cy - arrowSize); fgCtx.lineTo(cx - arrowSize, cy + arrowSize * 0.5); fgCtx.lineTo(cx + arrowSize, cy + arrowSize * 0.5);
    fgCtx.closePath(); fgCtx.fill();
    fgCtx.restore();

    let downAlpha = showClimb ? (touchState.climbDownActive ? 0.8 : 0.35) : 0.1;
    let downX = touchState.btnDownX; let downY = touchState.btnDownY;
    fgCtx.save();
    fgCtx.globalAlpha = downAlpha;
    fgCtx.fillStyle = touchState.climbDownActive ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.1)';
    fgCtx.beginPath(); fgCtx.roundRect(downX, downY, btnSize, btnSize, r); fgCtx.fill();
    fgCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)'; fgCtx.lineWidth = 1.5; fgCtx.stroke();
    fgCtx.fillStyle = '#fff'; fgCtx.beginPath();
    let cx2 = downX + btnSize / 2; let cy2 = downY + btnSize / 2;
    fgCtx.moveTo(cx2, cy2 + arrowSize); fgCtx.lineTo(cx2 - arrowSize, cy2 - arrowSize * 0.5); fgCtx.lineTo(cx2 + arrowSize, cy2 - arrowSize * 0.5);
    fgCtx.closePath(); fgCtx.fill();
    fgCtx.restore();
}

function random(min, max) { return Math.random() * (max - min) + min; }
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

init();
