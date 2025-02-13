const axios = require('axios');
const chalk = require('chalk');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const readline = require('readline');
const keypress = require('keypress');

let sockets = [];
let pingIntervals = [];
let countdownIntervals = [];
let potentialPoints = [];
let countdowns = [];
let pointsTotals = [];
let pointsToday = [];
let lastUpdateds = [];
let messages = [];
let userIds = [];
let browserIds = [];
let proxies = [];
let accessTokens = [];
let accounts = [];
let useProxy = false;
let enableAutoRetry = false;
let currentAccountIndex = 0;

function loadAccounts() {
  if (!fs.existsSync('account.txt')) {
    process.exit(1);
  }

  try {
    const data = fs.readFileSync('account.txt', 'utf8');
    accounts = data.split('\n').map(line => {
      const [email, password] = line.split(',');
      if (email && password) {
        return { email: email.trim(), password: password.trim() };
      }
      return null;
    }).filter(account => account !== null);
  } catch (err) {
    process.exit(1);
  }
}

function loadProxies() {
  if (!fs.existsSync('proxy.txt')) {
    process.exit(1);
  }

  try {
    const data = fs.readFileSync('proxy.txt', 'utf8');
    proxies = data.split('\n').map(line => line.trim()).filter(line => line);
  } catch (err) {
    process.exit(1);
  }
}

function normalizeProxyUrl(proxy) {
  if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) {
    proxy = 'http://' + proxy;
  }
  return proxy;
}

function promptUseProxy() {
  return new Promise((resolve) => {
    displayHeader();
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Do you want to use a proxy? (y/n): ', (answer) => {
      useProxy = answer.toLowerCase() === 'y';
      rl.close();
      resolve();
    });
  });
}

function promptEnableAutoRetry() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('Do you want to enable auto-retry for account errors? (y/n): ', (answer) => {
      enableAutoRetry = answer.toLowerCase() === 'y';
      rl.close();
      resolve();
    });
  });
}

async function initialize() {
  loadAccounts();
  loadProxies();
  await promptUseProxy();
  await promptEnableAutoRetry();

  if (useProxy && proxies.length < accounts.length) {
    process.exit(1);
  }

  for (let i = 0; i < accounts.length; i++) {
    potentialPoints[i] = 0;
    countdowns[i] = "Calculating...";
    pointsTotals[i] = 0;
    pointsToday[i] = 0;
    lastUpdateds[i] = null;
    messages[i] = '';
    userIds[i] = null;
    browserIds[i] = null;
    accessTokens[i] = null;
    getUserId(i);
  }

  displayAccountData(currentAccountIndex);
  handleUserInput();
}

function generateBrowserId(index) {
  return `browserId-${index}-${Math.random().toString(36).substring(2, 15)}`;
}

function displayHeader() {
  const width = process.stdout.columns;
  const headerLines = [
    "<|============================================|>",
    "                  Teneo Bot                   ",
    "<|============================================|>"
  ];

  headerLines.forEach(line => {
    const padding = Math.max(0, Math.floor((width - line.length) / 2));
  });
  const instructions = "Use 'A' to switch to the previous account, 'D' to switch to the next account, 'C' to exit.";
  const instructionsPadding = Math.max(0, Math.floor((width - instructions.length) / 2));
}

function displayAccountData(index) {
  console.clear();
  displayHeader();

  const width = process.stdout.columns;
  const separatorLine = '_'.repeat(width);
  const accountHeader = `Account ${index + 1}`;
  const padding = Math.max(0, Math.floor((width - accountHeader.length) / 2));

  console.log(chalk.cyan(separatorLine));
  console.log(chalk.cyan(' '.repeat(padding) + chalk.bold(accountHeader)));
  console.log(chalk.cyan(separatorLine));

  console.log(chalk.whiteBright(`Email: ${accounts[index].email}`));
  console.log(`User ID: ${userIds[index]}`);
  console.log(`Browser ID: ${browserIds[index]}`);
  console.log(chalk.green(`Points Total: ${pointsTotals[index]}`));
  console.log(chalk.green(`Points Today: ${pointsToday[index]}`));
  console.log(chalk.whiteBright(`Message: ${messages[index]}`));

  const proxy = proxies[index % proxies.length];
  if (useProxy && proxy) {
    console.log(chalk.hex('#FFA500')(`Proxy: ${proxy}`));
  } else {
    console.log(chalk.hex('#FFA500')(`Proxy: Not using proxy`));
  }

  console.log(chalk.cyan(separatorLine));
  console.log("\nStatus:");

  if (messages[index].startsWith("Error:")) {
    console.log(chalk.red(`Account ${index + 1}: ${messages[index]}`));
  } else {
    console.log(`Account ${index + 1}: Potential Points: ${potentialPoints[index]}, Countdown: ${countdowns[index]}`);
  }
}

function handleUserInput() {
  keypress(process.stdin);

  process.stdin.on('keypress', (ch, key) => {
    if (key && key.name === 'a') {
      currentAccountIndex = (currentAccountIndex - 1 + accounts.length) % accounts.length;
      displayAccountData(currentAccountIndex);
    } else if (key && key.name === 'd') {
      currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
      displayAccountData(currentAccountIndex);
    } else if (key && key.name === 'c') {
      process.exit();
    }
    if (key && key.ctrl && key.name === 'c') {
      process.stdin.pause();
    }
  });

  process.stdin.setRawMode(true);
  process.stdin.resume();
}

async function connectWebSocket(index) {
  if (sockets[index]) return;
  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(accessTokens[index])}&version=${encodeURIComponent(version)}`;

  const proxy = proxies[index % proxies.length];
  const agent = useProxy && proxy ? new HttpsProxyAgent(normalizeProxyUrl(proxy)) : null;

  sockets[index] = new WebSocket(wsUrl, { agent });

  sockets[index].onopen = async () => {
    lastUpdateds[index] = new Date().toISOString();
    startPinging(index);
    startCountdownAndPoints(index);
  };

  sockets[index].onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
      lastUpdateds[index] = new Date().toISOString();
      pointsTotals[index] = data.pointsTotal;
      pointsToday[index] = data.pointsToday;
      messages[index] = data.message;
    }

    if (data.message === "Pulse from server") {
      setTimeout(() => {
        startPinging(index);
      }, 10000);
    }
  };

  sockets[index].onclose = () => {
    reconnectWebSocket(index);
  };

  sockets[index].onerror = (error) => {
  };
}

async function reconnectWebSocket(index) {
  const version = "v0.2";
  const url = "wss://secure.ws.teneo.pro";
  const wsUrl = `${url}/websocket?accessToken=${encodeURIComponent(accessTokens[index])}&version=${encodeURIComponent(version)}`;

  const proxy = proxies[index % proxies.length];
  const agent = useProxy && proxy ? new HttpsProxyAgent(normalizeProxyUrl(proxy)) : null;

  if (sockets[index]) {
    sockets[index].removeAllListeners();
  }

  sockets[index] = new WebSocket(wsUrl, { agent });

  sockets[index].onopen = async () => {
    lastUpdateds[index] = new Date().toISOString();
    startPinging(index);
    startCountdownAndPoints(index);
  };

  sockets[index].onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
      lastUpdateds[index] = new Date().toISOString();
      pointsTotals[index] = data.pointsTotal;
      pointsToday[index] = data.pointsToday;
      messages[index] = data.message;
    }

    if (data.message === "Pulse from server") {
      setTimeout(() => {
        startPinging(index);
      }, 10000);
    }
  };

  sockets[index].onclose = () => {
    setTimeout(() => {
      reconnectWebSocket(index);
    }, 5000);
  };

  sockets[index].onerror = (error) => {
  };
}

function startCountdownAndPoints(index) {
  clearInterval(countdownIntervals[index]);
  updateCountdownAndPoints(index);
  countdownIntervals[index] = setInterval(() => updateCountdownAndPoints(index), 1000);
}

async function updateCountdownAndPoints(index) {
  const restartThreshold = 60000;
  const now = new Date();

  if (!lastUpdateds[index]) {
    lastUpdateds[index] = {};
  }

  if (countdowns[index] === "Calculating...") {
    const lastCalculatingTime = lastUpdateds[index].calculatingTime || now;
    const calculatingDuration = now.getTime() - lastCalculatingTime.getTime();

    if (calculatingDuration > restartThreshold) {
      reconnectWebSocket(index);
      return;
    }
  }

  if (lastUpdateds[index]) {
    const nextHeartbeat = new Date(lastUpdateds[index]);
    nextHeartbeat.setMinutes(nextHeartbeat.getMinutes() + 15);
    const diff = nextHeartbeat.getTime() - now.getTime();

    if (diff > 0) {
      const minutes = Math.floor(diff / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);
      countdowns[index] = `${minutes}m ${seconds}s`;

      const maxPoints = 25;
      const timeElapsed = now.getTime() - new Date(lastUpdateds[index]).getTime();
      const timeElapsedMinutes = timeElapsed / (60 * 1000);
      let newPoints = Math.min(maxPoints, (timeElapsedMinutes / 15) * maxPoints);
      newPoints = parseFloat(newPoints.toFixed(2));

      if (Math.random() < 0.1) {
        const bonus = Math.random() * 2;
        newPoints = Math.min(maxPoints, newPoints + bonus);
        newPoints = parseFloat(newPoints.toFixed(2));
      }

      potentialPoints[index] = newPoints;
    } else {
      countdowns[index] = "Calculating, it might take a minute before starting...";
      potentialPoints[index] = 25;

      lastUpdateds[index].calculatingTime = now;
    }
  } else {
    countdowns[index] = "Calculating, it might take a minute before starting...";
    potentialPoints[index] = 0;

    lastUpdateds[index].calculatingTime = now;
  }
}

function startPinging(index) {
  pingIntervals[index] = setInterval(async () => {
    if (sockets[index] && sockets[index].readyState === WebSocket.OPEN) {
      const proxy = proxies[index % proxies.length];
      const agent = useProxy && proxy ? new HttpsProxyAgent(normalizeProxyUrl(proxy)) : null;

      sockets[index].send(JSON.stringify({ type: "PING" }), { agent });
    }
  }, 30000);
}

function stopPinging(index) {
  if (pingIntervals[index]) {
    clearInterval(pingIntervals[index]);
    pingIntervals[index] = null;
  }
}

function restartAccountProcess(index) {
  disconnectWebSocket(index);
  connectWebSocket(index);
}

async function getUserId(index) {
  const loginUrl = "https://auth.teneo.pro/api/login";

  const proxy = proxies[index % proxies.length];
  const agent = useProxy && proxy ? new HttpsProxyAgent(normalizeProxyUrl(proxy)) : null;

  try {
    const response = await axios.post(loginUrl, {
      email: accounts[index].email,
      password: accounts[index].password
    }, {
      httpsAgent: agent,
      headers: {
        'Authorization': `Bearer ${accessTokens[index]}`,
        'Content-Type': 'application/json',
        'authority': 'auth.teneo.pro',
        'x-api-key': 'OwAG3kib1ivOJG4Y0OCZ8lJETa6ypvsDtGmdhcjB'
      }
    });

    const { user, access_token } = response.data;
    userIds[index] = user.id;
    accessTokens[index] = access_token;
    browserIds[index] = generateBrowserId(index);
    messages[index] = "Connected successfully";

    startCountdownAndPoints(index);
    await connectWebSocket(index);
  } catch (error) {
    const errorMessage = error.response ? error.response.data.message : error.message;
    messages[index] = `Error: ${errorMessage}`;

    if (enableAutoRetry) {
      const randomTime = Math.floor(Math.random() * (30000 - 5000 + 1)) + 5000;
      setTimeout(() => getUserId(index), randomTime);
    }
  }
}

initialize();
