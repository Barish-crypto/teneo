const axios = require('axios');
const chalk = require('chalk');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const readline = require('readline');
const keypress = require('keypress');

const API_URL = "https://auth.teneo.pro/api/login";
const WS_URL = "wss://secure.ws.teneo.pro/websocket";
const PING_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;
const POINTS_MAX = 25;
const COUNTDOWN_INTERVAL = 1000;

let accounts = [], proxies = [], sockets = [], accessTokens = [], userIds = [], browserIds = [], messages = [];
let pointsTotals = [], pointsToday = [], lastUpdateds = [], countdowns = [], potentialPoints = [];
let useProxy = false, enableAutoRetry = false, currentAccountIndex = 0;

const loadFile = (filename) => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean) : [];
const normalizeProxyUrl = (proxy) => proxy.startsWith('http') ? proxy : `http://${proxy}`;

async function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.toLowerCase() === 'y'); });
  });
}

async function initialize() {
  accounts = loadFile('account.txt').map(line => {
    const [email, password] = line.split(',').map(s => s.trim());
    return email && password ? { email, password } : null;
  }).filter(Boolean);
  proxies = loadFile('proxy.txt');
  
  useProxy = await prompt('Do you want to use a proxy? (y/n): ');
  enableAutoRetry = await prompt('Enable auto-retry for account errors? (y/n): ');

  if (useProxy && proxies.length < accounts.length) return process.exit(1);
  
  accounts.forEach((_, i) => initializeAccount(i));
  handleUserInput();
}

async function initializeAccount(index) {
  [potentialPoints[index], countdowns[index], pointsTotals[index], pointsToday[index], lastUpdateds[index], messages[index]] = [0, "Calculating...", 0, 0, null, ""];
  browserIds[index] = `browserId-${index}-${Math.random().toString(36).slice(2, 15)}`;
  await authenticate(index);
}

async function authenticate(index) {
  try {
    const agent = useProxy && proxies[index] ? new HttpsProxyAgent(normalizeProxyUrl(proxies[index])) : null;
    const { data } = await axios.post(API_URL, accounts[index], { httpsAgent: agent, headers: { 'x-api-key': 'OwAG3kib1ivOJG4Y0OCZ8lJETa6ypvsDtGmdhcjB' } });
    userIds[index] = data.user.id;
    accessTokens[index] = data.access_token;
    messages[index] = "Connected successfully";
    connectWebSocket(index);
  } catch (error) {
    messages[index] = `Error: ${error.response?.data?.message || error.message}`;
    if (enableAutoRetry) setTimeout(() => authenticate(index), Math.random() * (30000 - 5000) + 5000);
  }
}

function connectWebSocket(index) {
  if (sockets[index]) return;
  const agent = useProxy && proxies[index] ? new HttpsProxyAgent(normalizeProxyUrl(proxies[index])) : null;
  sockets[index] = new WebSocket(`${WS_URL}?accessToken=${encodeURIComponent(accessTokens[index])}&version=v0.2`, { agent });

  sockets[index].onopen = () => startPinging(index);
  sockets[index].onmessage = ({ data }) => handleMessage(index, JSON.parse(data));
  sockets[index].onclose = () => reconnectWebSocket(index);
  sockets[index].onerror = () => reconnectWebSocket(index);
}

function reconnectWebSocket(index) {
  setTimeout(() => {
    sockets[index]?.removeAllListeners();
    sockets[index] = null;
    connectWebSocket(index);
  }, RECONNECT_DELAY);
}

function handleMessage(index, data) {
  if (data.pointsTotal !== undefined && data.pointsToday !== undefined) {
    [pointsTotals[index], pointsToday[index], messages[index]] = [data.pointsTotal, data.pointsToday, data.message];
    lastUpdateds[index] = new Date().toISOString();
  }
}

function startPinging(index) {
  setInterval(() => sockets[index]?.send(JSON.stringify({ type: "PING" })), PING_INTERVAL);
}

function displayAccountData(index) {
  console.clear();
  console.log(chalk.cyan('='.repeat(process.stdout.columns)));
  console.log(chalk.bold(`Account ${index + 1} | Email: ${accounts[index].email}`));
  console.log(`User ID: ${userIds[index]} | Browser ID: ${browserIds[index]}`);
  console.log(chalk.green(`Points Total: ${pointsTotals[index]} | Points Today: ${pointsToday[index]}`));
  console.log(chalk.hex('#FFA500')(`Proxy: ${useProxy ? proxies[index % proxies.length] : 'Not using'}`));
  console.log(chalk.whiteBright(`Message: ${messages[index]}`));
  console.log(chalk.cyan('='.repeat(process.stdout.columns)));
}

function handleUserInput() {
  keypress(process.stdin);
  process.stdin.on('keypress', (_, key) => {
    if (!key) return;
    if (key.name === 'a') currentAccountIndex = (currentAccountIndex - 1 + accounts.length) % accounts.length;
    if (key.name === 'd') currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
    if (key.name === 'c') process.exit();
    displayAccountData(currentAccountIndex);
  });
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

initialize();