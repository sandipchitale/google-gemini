import * as ChromeLauncher from 'chrome-launcher';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { stdin } from 'node:process';
import { Browser, connect, ElementHandle, Page, Target } from 'puppeteer-core';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const REMOTE_PORT: number = 19224;
const REMOTE_DEBUGGING_URL = `http://127.0.0.1:${REMOTE_PORT}`;

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function launchChrome() {
    // 1. Launch Chrome using chrome-launcher
    const userDataDir = path.join(tmpdir(), 'google-gemini-user-data-dir');

    // Ensure the directory exists, otherwise chrome-launcher fails to open log files
    mkdirSync(userDataDir, { recursive: true });

    let chrome = await ChromeLauncher.launch({
        port: REMOTE_PORT,
        startingUrl: 'about:blank',
        userDataDir,
        chromeFlags: [
            '--new-window',
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
        ],
    });
}

async function ensureSession(sessionId: string) {
    // if port is available, launch chrome
    if (await isPortAvailable(REMOTE_PORT)) {
        await launchChrome();
        delay(5000);
    }

    const existingPage = await findPageForSession(sessionId);
    if (existingPage) {
        return;
    }

    await delay(1000);

    // Connect to the existing instance
    const browser: Browser = await connect({
        browserURL: REMOTE_DEBUGGING_URL,
        defaultViewport: null // Matches the browser's current window size
    });

    await delay(1000);

    const pages = (await browser.pages());

    // create page for session
    const page: Page = await browser.newPage();

    // Perform an action: Navigate and wait until network is idle
    await page.goto('https://gemini.google.com', { waitUntil: 'networkidle2' });
    await delay(1000);

    // close about:blank page if it exists
    for (const aPage of pages) {
        if (aPage.url() === 'about:blank') {
            await aPage.close({ runBeforeUnload: false });
            break;
        }
    }

    // Set the window.name property
    await page.evaluate((sessionId) => {
        window.name = sessionId;
    }, sessionId);

    // add code to enable the canvas tool
    try {
        const toolsToggleButton = await page.waitForSelector('toolbox-drawer button:first-of-type', { timeout: 10000 });
        if (toolsToggleButton) {
            await toolsToggleButton.click();
            await delay(1000);
            const canvasButton = await page.waitForSelector('toolbox-drawer-item:nth-of-type(2) button', { timeout: 5000 });
            if (canvasButton) {
                await canvasButton.click();
            }
        }
    } catch (error) {
        console.error('Error enabling canvas tool:', error);
    }

}

async function findPageForSession(sessionId: string): Promise<Page | undefined> {
    // Connect to the existing instance
    const browser: Browser = await connect({
        browserURL: REMOTE_DEBUGGING_URL,
        defaultViewport: null // Matches the browser's current window size
    });

    // 1. Get all targets
    const targets: Target[] = browser.targets();

    // 2. Filter for actual pages (tabs/windows)
    const pageTargets = targets.filter(t => t.type() === 'page');

    // 3. Find page for session concurrently
    const pages = await Promise.all(pageTargets.map(t => t.asPage()));
    const validPages = pages.filter((p): p is Page => p !== null);

    const matchingPages = await Promise.all(validPages.map(async (page) => {
        const windowName = await page.evaluate(() => window.name).catch(() => null);
        return { page, isMatch: windowName === sessionId };
    }));

    return matchingPages.find(p => p.isMatch)?.page;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function safeExecute(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (error) {
        console.error('Error executing hook:', error);
        process.exit(1);
    }
}

async function typeMultilineTextInPromptBox(page: Page, promptBox: ElementHandle<Element>, text: string) {
    if (text) {
        await promptBox.click();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            await promptBox.type(line);
            if (i < lines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
            }
        }
    }
}

(await (async () => {
    const sessionId = process.ppid.toString();

    // Ensure a tab dedicated to this session
    await ensureSession(sessionId);

    let stdinInput = undefined;
    // STDIN is not terminal, read it
    if (!stdin.isTTY) {
        stdinInput = await readStdin();
    }

    let promptAppendix: string = '';
    if (process.argv.length > 2) {
        // everything after first argument is the promptAppendix
        promptAppendix = process.argv.slice(2).join(' ');
    }

    await safeExecute(async () => {
        const page = await findPageForSession(sessionId);
        if (page) {
            const promptBox = await page.$('rich-textarea');
            if (promptBox) {
                await typeMultilineTextInPromptBox(page, promptBox, `MANDATORY: Use canvas tool to process this prompt:\n\n${stdinInput ? stdinInput + '\n\n' : ''}${promptAppendix}`);
                await delay(1000);
                await page.keyboard.up('Enter');
                await page.keyboard.press('Enter');
            }
        }
    });
    process.exit(0);
}))();
