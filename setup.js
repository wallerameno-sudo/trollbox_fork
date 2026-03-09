// setup.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function ANSI_GREEN(text) { return `\x1b[32m${text}\x1b[0m`; }
function ANSI_YELLOW(text) { return `\x1b[33m${text}\x1b[0m`; }
function ANSI_BLUE(text) { return `\x1b[34m${text}\x1b[0m`; }
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
    }));
}
function randomString(length = 32) {
    return [...Array(length)].map(() => (Math.random() * 36 | 0).toString(36)).join('');
}

async function setup() {
    const envPath = path.join(__dirname, '.env');
    const bannedPath = path.join(__dirname, 'banned_homes.json');
    const authPath = path.join(__dirname, 'authorized_homes.json');

    // Check if .env already exists and has required keys
    let isSetup = false;
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const hasPort = /PORT=/.test(envContent);
        const hasHomeSalt = /HOME_SALT=/.test(envContent);
        const hasToken = /TOKEN=/.test(envContent);
        if (hasPort && hasHomeSalt && hasToken) isSetup = true;
    }

    if (isSetup) {
        return false;
    } else {
        console.log(ANSI_YELLOW("Welcome to Trollbox setup! Let's create your .env file."));

        const portInput = await ask(ANSI_GREEN('Enter the server port (default 3000): '));
        const port = portInput || '3000';

        const homeSaltInput = await ask(ANSI_GREEN('Enter HOME_SALT (leave blank to generate a random one): '));
        const homeSalt = homeSaltInput || randomString();

        const tokenInput = await ask(ANSI_GREEN('Enter TOKEN (leave blank to generate a random one): '));
        const token = tokenInput || randomString();

        const envContent = `PORT=${port}\nHOME_SALT=${homeSalt}\nTOKEN=${token}\n`;
        fs.writeFileSync(envPath, envContent, 'utf-8');
        console.log(ANSI_BLUE('.env file created successfully!'));
    
    }

    // Ensure banned_homes.json exists
    if (!fs.existsSync(bannedPath)) {
        fs.writeFileSync(bannedPath, '[]', 'utf-8');
        console.log(ANSI_BLUE('banned_homes.json created.'));
    } else {
        console.log(ANSI_BLUE('banned_homes.json already exists.'));
    }

    // Ensure authorized_homes.json exists
    if (!fs.existsSync(authPath)) {
        fs.writeFileSync(authPath, '[]', 'utf-8');
        console.log(ANSI_BLUE('authorized_homes.json created.'));
    } else {
        console.log(ANSI_BLUE('authorized_homes.json already exists.'));
    }

    console.log(ANSI_GREEN("Setup complete! You can now run the server with 'node server.js'"));
    return true
}

module.exports = setup;

// If run directly, execute setup