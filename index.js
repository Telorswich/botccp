import puppeteer from 'puppeteer';
import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import { TELEGRAM_CONFIG } from './config.js';

// Konfigurasi Telegram Bot
const TELEGRAM_BOT_TOKEN = TELEGRAM_CONFIG.BOT_TOKEN;
const TELEGRAM_CHAT_ID = TELEGRAM_CONFIG.CHAT_ID;

// Sistem Antrian
let queue = [];
let isProcessing = false;
let queueUpdateInterval = null;

// ====== OWNER / ADMIN HELPERS ======
const isOwner = (chatId) => String(chatId) === String(TELEGRAM_CHAT_ID);

const notifyOwner = async (message) => {
    try {
        await sendToTelegram(message, TELEGRAM_CHAT_ID);
    } catch (e) {
        // ignore
    }
};

// Statistik pembuat akun per user
// Map<chatId, { username: string, totalRequested: number, totalSuccess: number, totalFailed: number, lastAt: Date }>
const creatorStats = new Map();

const ensureCreator = (chatId, username) => {
    if (!creatorStats.has(chatId)) {
        creatorStats.set(chatId, {
            username,
            totalRequested: 0,
            totalSuccess: 0,
            totalFailed: 0,
            lastAt: new Date()
        });
    } else {
        const c = creatorStats.get(chatId);
        if (username && c.username !== username) c.username = username;
        c.lastAt = new Date();
    }
    return creatorStats.get(chatId);
};

const formatHandle = (rawUsername) => {
    if (!rawUsername) return 'User';
    if (rawUsername.startsWith('@')) return rawUsername;
    // If contains space, likely a first name, keep as is
    return rawUsername.match(/^\w+$/) ? `@${rawUsername}` : rawUsername;
};

// State pemilihan password per-user sebelum masuk antrian
// Map<chatId, { accountCount: number, username: string, waitingForPassword: boolean, timeoutId: NodeJS.Timeout | null }>
const pendingPasswordSelection = new Map();

// Fungsi untuk menambahkan user ke antrian
const addToQueue = (chatId, username, accountCount, passwordOverride = null) => {
    const handle = formatHandle(username);
    const stats = ensureCreator(chatId, handle);
    stats.totalRequested += accountCount;
    const queueItem = {
        id: Date.now() + Math.random(),
        chatId: chatId,
        username: handle || 'User',
        accountCount: accountCount,
        position: queue.length + 1,
        status: 'waiting',
        startTime: new Date(),
        messageId: null,
        passwordOverride: passwordOverride
    };
    
    queue.push(queueItem);
    // Notify owner on new queue item (with handle)
    notifyOwner(`🆕 <b>QUEUE NEW</b>\n👤 <b>User:</b> ${handle} (chatId: <code>${queueItem.chatId}</code>)\n🎯 <b>Jumlah:</b> ${queueItem.accountCount}\n📍 <b>Posisi:</b> ${queueItem.position}`);
    return queueItem;
};

// Kirim prompt untuk memilih mode password
const promptPasswordChoice = async (chatId, username, accountCount) => {
    pendingPasswordSelection.set(chatId, {
        accountCount,
        username,
        waitingForPassword: false,
        timeoutId: null
    });

    const message = `🔐 <b>PILIH MODE PASSWORD</b>\n\n` +
        `Silakan pilih mode password untuk ${accountCount} akun yang akan dibuat:\n\n` +
        `• <b>Random</b>: Password acak 8-12 karakter (disarankan)\n` +
        `• <b>Custom</b>: Ketik password sendiri (min. 6 karakter)`;

    const keyboard = [
        [
            { text: '🎲 Random', callback_data: 'pw_random' },
            { text: '🔑 Custom', callback_data: 'pw_custom' }
        ]
    ];

    await sendKeyboard(message, keyboard, chatId);
};

// Fungsi untuk menghapus user dari antrian
const removeFromQueue = (queueId) => {
    queue = queue.filter(item => item.id !== queueId);
    updateQueuePositions();
};

// Fungsi untuk update posisi antrian
const updateQueuePositions = () => {
    queue.forEach((item, index) => {
        item.position = index + 1;
    });
};

// Tampilkan ringkasan antrian saat ini
const showQueue = async (chatId = TELEGRAM_CHAT_ID) => {
    const position = getQueuePosition(chatId);
    const total = queue.length;
    let header = `📊 <b>STATUS ANTRIAN</b>\n\n`;
    if (total === 0) {
        await sendToTelegram(header + '✅ Tidak ada antrian saat ini.\n\nKetik <code>/create</code> untuk mulai.', chatId);
        return;
    }
    const userInfo = position > 0 ? `👤 <b>Posisi Anda:</b> ${position} dari ${total}\n` : '👤 Anda belum ada di antrian.\n';
    let list = '';
    queue.slice(0, 5).forEach((it, idx) => {
        const icon = it.status === 'processing' ? '🔄' : '⏳';
        const elapsed = Math.floor((new Date() - it.startTime) / 1000);
        list += `${icon} <b>${idx + 1}.</b> ${it.username} (${it.accountCount} akun) - ${elapsed}s\n`;
    });
    if (queue.length > 5) list += `... dan ${queue.length - 5} lainnya\n`;
    const msg = header + userInfo + `📈 <b>Total:</b> ${total}\n\n` + list + `\nKetik <code>/create</code> untuk menambah antrian.`;
    await sendToTelegram(msg, chatId);
};

// Fungsi untuk mendapatkan posisi user dalam antrian
const getQueuePosition = (chatId) => {
    return queue.findIndex(item => item.chatId === chatId) + 1;
};

// Fungsi untuk mengirim animasi antrian
const sendQueueAnimation = async (chatId, position, totalInQueue) => {
    const queueMessage = `🎬 <b>ANTRIAN CAPCUT ACCOUNT CREATOR</b> 🎬\n\n` +
        `👤 <b>User:</b> ${queue.find(item => item.chatId === chatId)?.username || 'User'}\n` +
        `📊 <b>Posisi:</b> ${position} dari ${totalInQueue}\n` +
        `🎯 <b>Jumlah Akun:</b> ${queue.find(item => item.chatId === chatId)?.accountCount || 1}\n\n` +
        `⏳ <b>Status:</b> Menunggu giliran...\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🔄 <b>Antrian Saat Ini:</b>\n`;
    
    let queueList = '';
    queue.slice(0, 5).forEach((item, index) => {
        const status = item.status === 'processing' ? '🔄' : '⏳';
        const time = Math.floor((new Date() - item.startTime) / 1000);
        queueList += `${status} <b>${index + 1}.</b> ${item.username} (${item.accountCount} akun) - ${time}s\n`;
    });
    
    if (queue.length > 5) {
        queueList += `... dan ${queue.length - 5} user lainnya\n`;
    }
    
    const fullMessage = queueMessage + queueList;
    
    try {
        const messageId = await sendToTelegram(fullMessage, chatId);
        return messageId;
    } catch (error) {
        console.error('Gagal mengirim animasi antrian:', error);
        return null;
    }
};

// Fungsi untuk update animasi antrian secara real-time
const updateQueueAnimations = async () => {
    for (const item of queue) {
        if (item.status === 'waiting' && item.messageId) {
            try {
                const position = getQueuePosition(item.chatId);
                const totalInQueue = queue.length;
                
                const queueMessage = `🎬 <b>ANTRIAN CAPCUT ACCOUNT CREATOR</b> 🎬\n\n` +
                    `👤 <b>User:</b> ${item.username}\n` +
                    `📊 <b>Posisi:</b> ${position} dari ${totalInQueue}\n` +
                    `🎯 <b>Jumlah Akun:</b> ${item.accountCount}\n\n` +
                    `⏳ <b>Status:</b> Menunggu giliran...\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `🔄 <b>Antrian Saat Ini:</b>\n`;
                
                let queueList = '';
                queue.slice(0, 5).forEach((queueItem, index) => {
                    const status = queueItem.status === 'processing' ? '🔄' : '⏳';
                    const time = Math.floor((new Date() - queueItem.startTime) / 1000);
                    queueList += `${status} <b>${index + 1}.</b> ${queueItem.username} (${queueItem.accountCount} akun) - ${time}s\n`;
                });
                
                if (queue.length > 5) {
                    queueList += `... dan ${queue.length - 5} user lainnya\n`;
                }
                
                const fullMessage = queueMessage + queueList;
                
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                    chat_id: item.chatId,
                    message_id: item.messageId,
                    text: fullMessage,
                    parse_mode: 'HTML'
                });
            } catch (error) {
                console.error('Gagal update animasi antrian:', error);
            }
        }
    }
};

// Fungsi untuk memproses antrian
const processQueue = async () => {
    if (isProcessing || queue.length === 0) return;
    
    isProcessing = true;
    
    // Mulai interval untuk update animasi antrian
    if (!queueUpdateInterval) {
        queueUpdateInterval = setInterval(updateQueueAnimations, 3000); // Update setiap 3 detik
    }
    
    while (queue.length > 0) {
        const currentItem = queue[0];
        currentItem.status = 'processing';
        
        // Hapus pesan antrian lama
        if (currentItem.messageId) {
            await deleteTelegramMessage(currentItem.messageId, currentItem.chatId);
        }
        
        // Kirim pesan mulai proses
        const startMessageId = await sendToTelegram(`🚀 <b>Memulai pembuatan ${currentItem.accountCount} akun CapCut...</b>\n\n⏳ Proses dimulai...`, currentItem.chatId);
        
        const successfulAccounts = [];
        
        for (let i = 1; i <= currentItem.accountCount; i++) {
            const account = await createCapCutAccount(i, currentItem.accountCount, currentItem.chatId, currentItem.passwordOverride || null);
            if (account) {
                successfulAccounts.push(account);
            }
            
            // Jeda acak antara akun (3-10 detik)
            if (i < currentItem.accountCount) {
                const delay = Math.floor(Math.random() * 7000) + 3000;
                const waitMessageId = await sendToTelegram(`⏳ Menunggu ${delay/1000} detik sebelum membuat akun berikutnya...`, currentItem.chatId);
                await new Promise(resolve => setTimeout(resolve, delay));
                // Hapus pesan tunggu
                if (waitMessageId) {
                    await deleteTelegramMessage(waitMessageId, currentItem.chatId);
                }
            }
        }
        
        // Hapus pesan "Akan membuat X akun" dan "Proses dimulai"
        if (startMessageId) {
            await deleteTelegramMessage(startMessageId, currentItem.chatId);
        }
        
        // Kirim ringkasan
        const summaryMessage = `🎉 <b>PROSES PEMBUATAN AKUN CAPCUT SELESAI!</b>\n\n` +
            `📊 <b>Ringkasan:</b>\n` +
            `✅ Berhasil dibuat: ${successfulAccounts.length} akun\n` +
            `❌ Gagal dibuat: ${currentItem.accountCount - successfulAccounts.length} akun\n` +
            `📅 Selesai pada: ${new Date().toLocaleString('id-ID')}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Ketik /create untuk membuat akun lagi!`;
        
        await sendToTelegram(summaryMessage, currentItem.chatId);

        // Update stats and notify owner about completion
        const s = ensureCreator(currentItem.chatId, currentItem.username);
        s.totalSuccess += successfulAccounts.length;
        s.totalFailed += currentItem.accountCount - successfulAccounts.length;
        await notifyOwner(`✅ <b>QUEUE DONE</b>\n👤 <b>User:</b> ${currentItem.username} (chatId: <code>${currentItem.chatId}</code>)\n🎯 <b>Jumlah:</b> ${currentItem.accountCount}\n✅ <b>Berhasil:</b> ${successfulAccounts.length}\n❌ <b>Gagal:</b> ${currentItem.accountCount - successfulAccounts.length}`);
        
        // Hapus dari antrian
        removeFromQueue(currentItem.id);
        
        // Update animasi untuk semua user yang masih menunggu
        await updateQueueAnimations();
    }
    
    isProcessing = false;
    
    // Hentikan interval jika antrian kosong
    if (queue.length === 0 && queueUpdateInterval) {
        clearInterval(queueUpdateInterval);
        queueUpdateInterval = null;
    }
};

// Fungsi untuk mengirim pesan ke Telegram
const sendToTelegram = async (message, chatId = TELEGRAM_CHAT_ID) => {
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await axios.post(telegramUrl, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(chalk.green('📱 Pesan berhasil dikirim ke Telegram!'));
        return response.data.result.message_id;
    } catch (error) {
        console.error(chalk.red('❌ Gagal mengirim pesan ke Telegram:'), error.message);
        return false;
    }
};

// Helper: update pesan Telegram (editMessageText)
const updateTelegramMessage = async (messageId, chatId = TELEGRAM_CHAT_ID, message = '') => {
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
        await axios.post(telegramUrl, {
            chat_id: chatId,
            message_id: messageId,
            text: message,
            parse_mode: 'HTML'
        });
        return true;
    } catch (error) {
        return false;
    }
};

// Helper: pastikan ada satu pesan progress yang sama (kirim jika belum ada, update jika sudah)
const ensureProgressMessage = async (chatId = TELEGRAM_CHAT_ID, existingMessageId = null, message = '') => {
    if (!existingMessageId) {
        return await sendToTelegram(message, chatId);
    }
    await updateTelegramMessage(existingMessageId, chatId, message);
    return existingMessageId;
};

// Helper: kirim progress ke Telegram, mengembalikan message_id untuk dihapus nanti
const sendProgress = async (message, chatId = TELEGRAM_CHAT_ID) => {
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await axios.post(telegramUrl, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
        return response.data.result.message_id;
    } catch (error) {
        return null;
    }
};

// Fungsi untuk menghapus pesan di Telegram
const deleteTelegramMessage = async (messageId, chatId = TELEGRAM_CHAT_ID) => {
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;
        await axios.post(telegramUrl, {
            chat_id: chatId,
            message_id: messageId
        });
        return true;
    } catch (error) {
        console.error(chalk.red('❌ Gagal menghapus pesan:'), error.message);
        return false;
    }
};

// Fungsi untuk mengirim keyboard inline
const sendKeyboard = async (message, keyboard, chatId = TELEGRAM_CHAT_ID) => {
    try {
        const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(telegramUrl, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
        return true;
    } catch (error) {
        console.error(chalk.red('❌ Gagal mengirim keyboard:'), error.message);
        return false;
    }
};

// Fungsi untuk menghasilkan password acak
const generateRandomPassword = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    
    // Panjang password antara 8-12 karakter
    const length = Math.floor(Math.random() * 5) + 8;
    
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return password;
};

// Variable untuk menyimpan password custom
let customPassword = null;

// Fungsi untuk mengatur password custom
const setCustomPassword = (password) => {
    customPassword = password;
    console.log(chalk.green(`🔑 Password custom diatur: ${password}`));
};

// Fungsi untuk menghapus password custom (kembali ke random)
const clearCustomPassword = () => {
    customPassword = null;
    console.log(chalk.blue('🔑 Password custom dihapus, kembali ke password acak'));
};

// Fungsi untuk membaca password dari file password.txt atau generate random
const getPassword = () => {
    // Jika ada password custom, gunakan itu
    if (customPassword) {
        console.log(chalk.green(`🔑 Menggunakan password custom: ${customPassword}`));
        return customPassword;
    }
    
    try {
        console.log(chalk.blue('🔑 Membaca password dari file password.txt...'));
        const password = fs.readFileSync('password.txt', 'utf8').trim();
        if (password) {
            console.log(chalk.green(`🔑 Menggunakan password dari file: ${password}`));
            return password;
        }
    } catch (error) {
        console.log(chalk.blue('🔑 File password.txt tidak ditemukan, menggunakan password acak...'));
    }
    
    // Generate password acak jika file tidak ada atau kosong
    const randomPassword = generateRandomPassword();
    console.log(chalk.green(`🔑 Password acak yang dihasilkan: ${randomPassword}`));
    return randomPassword;
};

// Fungsi untuk membuat akun CapCut
const createCapCutAccount = async (accountNumber, totalAccounts, chatId, passwordOverride = null) => {
    const browser = await puppeteer.launch({ 
        headless: true,
        executablePath: '/usr/bin/chromium-browser', // Path ke Chromium system
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();

    // Gunakan User-Agent random
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Atur viewport secara acak
    await page.setViewport({
        width: Math.floor(Math.random() * (1920 - 1280) + 1280),
        height: Math.floor(Math.random() * (1080 - 720) + 720),
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
    });

    console.log(chalk.magenta(`\n🚀 Memproses akun ${accountNumber} dari ${totalAccounts}`));
    
    // Kirim status/progress utama ke Telegram
    const statusMessageId = await sendToTelegram(`🔄 <b>Memproses akun ${accountNumber} dari ${totalAccounts}...</b>`, chatId);
    let progressMessageId = await sendToTelegram('⏳ <b>Memulai...</b>', chatId);

    // Ambil email dari Temp-Mail
    const emailSpinner = ora(chalk.blue('Mendapatkan email dari Tempmail')).start();
    progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '📧 <b>Mendapatkan email dari Tempmail...</b>');
    let email = '';

    try {
        const response = await axios.post('https://api.internal.temp-mail.io/api/v3/email/new', {
            min_name_length: 10,
            max_name_length: 10
        }, { headers: { 'Content-Type': 'application/json' } });

        email = response.data.email;
        emailSpinner.succeed(chalk.green(`Email yang digunakan: ${email}`));
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, `📧 <b>Email didapatkan:</b> <code>${email}</code>`);
        }
    } catch (error) {
        emailSpinner.fail(chalk.red('Gagal mendapatkan email!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal mendapatkan email!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    // Dapatkan password: gunakan override jika ada
    const password = passwordOverride || getPassword();

    // Mulai proses pendaftaran di CapCut
    const signupSpinner = ora(chalk.blue('Membuka halaman signup CapCut...')).start();
    progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '🌐 <b>Membuka halaman signup CapCut...</b>');
    try {
        await page.goto('https://www.capcut.com/id-id/signup', { waitUntil: 'networkidle2', timeout: 60000 });
        signupSpinner.succeed(chalk.green('Halaman signup dibuka!'));
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '✅ <b>Halaman signup dibuka!</b>');
        }
    } catch (error) {
        signupSpinner.fail(chalk.red('Gagal membuka halaman signup!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal membuka halaman signup!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    const inputSpinner = ora(chalk.blue('Mengisi email...')).start();
    progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '⌨️ <b>Mengisi email...</b>');
    try {
        // Isi email
        await page.type('input[name="signUsername"]', email, { delay: 100 });

        // Klik tombol lanjut
        await page.waitForSelector('.lv_sign_in_panel_wide-primary-button', { visible: true, timeout: 10000 });
        await page.click('.lv_sign_in_panel_wide-primary-button');

        inputSpinner.succeed(chalk.green('Berhasil mengisi email!'));
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '✅ <b>Email terisi!</b>');
        }
    } catch (error) {
        inputSpinner.fail(chalk.red('Gagal mengisi email!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal mengisi email!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    // Isi password
    try {
        progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '🔒 <b>Mengisi password...</b>');
        await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
        await page.type('input[type="password"]', password, { delay: 100 });

        // Klik tombol daftar
        await page.waitForSelector('.lv_sign_in_panel_wide-sign-in-button', { visible: true, timeout: 10000 });
        await page.click('.lv_sign_in_panel_wide-sign-in-button');
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '✅ <b>Password terisi, melanjutkan pendaftaran...</b>');
        }
    } catch (error) {
        console.error(chalk.red('Gagal dalam proses pendaftaran!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal dalam proses pendaftaran!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    // Tunggu hingga input tanggal lahir muncul
    try {
        progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '📆 <b>Mengisi tanggal lahir...</b>');
        await page.waitForSelector('.gate_birthday-picker-input', { visible: true, timeout: 10000 });
    } catch (error) {
        console.error(chalk.red('Gagal memuat halaman tanggal lahir!'));
        if (progressMessageId) await deleteTelegramMessage(progressMessageId, chatId);
        await sendToTelegram('❌ <b>Gagal memuat halaman tanggal lahir!</b>', chatId);
        console.error(error);
        await browser.close();
        return null;
    }

    // Fungsi untuk mendapatkan angka acak dalam rentang tertentu
    const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // Tahun acak antara 1990 - 2005
    const randomYear = getRandomInt(1990, 2005);

    // Daftar bulan dan jumlah hari
    const months = [
        { name: "Januari", days: 31 },
        { name: "Februari", days: 28 },
        { name: "Maret", days: 31 },
        { name: "April", days: 30 },
        { name: "Mei", days: 31 },
        { name: "Juni", days: 30 },
        { name: "Juli", days: 31 },
        { name: "Agustus", days: 31 },
        { name: "September", days: 30 },
        { name: "Oktober", days: 31 },
        { name: "November", days: 30 },
        { name: "Desember", days: 31 }
    ];

    // Pilih bulan acak
    const randomMonthIndex = getRandomInt(0, months.length - 1);
    const randomMonth = months[randomMonthIndex].name;

    // Pilih hari acak sesuai bulan
    const randomDay = getRandomInt(1, months[randomMonthIndex].days);

    // Isi tahun lahir dengan nilai acak
    try {
        await page.type('.gate_birthday-picker-input', String(randomYear), { delay: 100 });

        // Pilih dropdown bulan
        await page.click('.gate_birthday-picker-selector:nth-of-type(1)');
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.waitForSelector('.lv-select-popup li', { visible: true, timeout: 5000 });

        // Pilih bulan acak dari dropdown
        await page.evaluate((randomMonth) => {
            let items = document.querySelectorAll('.lv-select-popup li');
            items.forEach(item => {
                if (item.innerText.trim() === randomMonth) {
                    item.click();
                }
            });
        }, randomMonth);

        // Pilih dropdown hari
        await page.click('.gate_birthday-picker-selector:nth-of-type(2)');
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.waitForSelector('.lv-select-popup li', { visible: true, timeout: 5000 });

        // Pilih hari acak dari dropdown
        await page.evaluate((randomDay) => {
            let items = document.querySelectorAll('.lv-select-popup li');
            items.forEach(item => {
                if (item.innerText.trim() === String(randomDay)) {
                    item.click();
                }
            });
        }, randomDay);

        console.log(chalk.green(`📆 Tanggal lahir yang dipilih: ${randomDay} ${randomMonth} ${randomYear}`));
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, `✅ <b>Tanggal lahir:</b> ${randomDay} ${randomMonth} ${randomYear}`);
        }

        // Klik tombol "Berikutnya"
        await page.waitForSelector('.lv_sign_in_panel_wide-birthday-next', { visible: true, timeout: 5000 });
        await page.click('.lv_sign_in_panel_wide-birthday-next');
    } catch (error) {
        console.error(chalk.red('Gagal mengisi tanggal lahir!'));
        console.error(error);
        await browser.close();
        return null;
    }

    // Ambil kode OTP
    const otpSpinner = ora(chalk.blue('Menunggu kode OTP dari email...')).start();
    progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '📨 <b>Menunggu kode OTP dari email...</b>');
    let otpCode = '';
    try {
        let otpResponse;
        let attempts = 0;
        do {
            await new Promise(resolve => setTimeout(resolve, 5000)); // Tunggu 5 detik
            otpResponse = await axios.get(`https://api.internal.temp-mail.io/api/v3/email/${email}/messages`);
            attempts++;
        } while (otpResponse.data.length === 0 && attempts < 10); // Max 10 kali (50 detik)

        if (otpResponse.data.length > 0) {
            const latestEmail = otpResponse.data[0];
            const match = latestEmail.body_text.match(/(\d{6})/);
            if (match) {
                otpCode = match[1];
                otpSpinner.succeed(chalk.green(`📩 Kode OTP yang diterima: ${otpCode}`));
                if (progressMessageId) {
                    progressMessageId = await ensureProgressMessage(chatId, progressMessageId, `📩 <b>OTP diterima:</b> <code>${otpCode}</code>`);
                }
            } else {
                otpSpinner.fail(chalk.red('Kode OTP tidak ditemukan dalam email.'));
                if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>OTP tidak ditemukan dalam email.</b>');
                await browser.close();
                return null;
            }
        } else {
            otpSpinner.fail(chalk.red('Tidak ada email masuk setelah 50 detik.'));
            if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Tidak ada email OTP masuk setelah 50 detik.</b>');
            await browser.close();
            return null;
        }
    } catch (error) {
        otpSpinner.fail(chalk.red('Gagal mengambil kode OTP!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal mengambil kode OTP!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    // Masukkan kode OTP
    try {
        progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '⌨️ <b>Memasukkan kode OTP...</b>');
        await page.waitForSelector('input.lv-input', { visible: true, timeout: 10000 });
        await page.type('input.lv-input', otpCode, { delay: 100 });
        console.log(chalk.green('✅ Kode OTP dimasukkan dan verifikasi berhasil!'));
        if (progressMessageId) {
            progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '✅ <b>OTP dimasukkan dan verifikasi berhasil!</b>');
        }
    } catch (error) {
        console.error(chalk.red('Gagal memasukkan kode OTP!'));
        if (progressMessageId) progressMessageId = await ensureProgressMessage(chatId, progressMessageId, '❌ <b>Gagal memasukkan kode OTP!</b>');
        console.error(error);
        await browser.close();
        return null;
    }

    // Hapus pesan progress/status agar tidak spam
    if (progressMessageId) {
        await deleteTelegramMessage(progressMessageId, chatId);
    }
    if (statusMessageId) {
        await deleteTelegramMessage(statusMessageId, chatId);
    }

    // Kirim informasi akun ke Telegram
    const accountData = `🎬 <b>AKUN CAPCUT BARU BERHASIL DIBUAT!</b>\n\n` +
        `📊 <b>Akun #${accountNumber}</b>\n` +
        `📧 <b>Email:</b> <code>${email}</code>\n` +
        `🔑 <b>Password:</b> <code>${password}</code>\n` +
        `📅 <b>Tanggal Lahir:</b> ${randomDay} ${randomMonth} ${randomYear}\n` +
        `⏰ <b>Waktu Dibuat:</b> ${new Date().toLocaleString('id-ID')}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    const telegramSent = await sendToTelegram(accountData, chatId);
    
    if (telegramSent) {
        console.log(chalk.green(`📱 Informasi akun berhasil dikirim ke Telegram!`));
    } else {
        console.log(chalk.yellow(`⚠️ Gagal mengirim ke Telegram, menyimpan ke file sebagai backup...`));
        // Backup ke file jika Telegram gagal
        const backupData = `Akun #${accountNumber}\nEmail: ${email}\nPassword: ${password}\nTanggal Lahir: ${randomDay} ${randomMonth} ${randomYear}\n----------------------\n`;
        fs.appendFileSync('accounts_backup.txt', backupData, 'utf8');
    }

    // Tunggu beberapa detik sebelum menutup
    await new Promise(resolve => setTimeout(resolve, 3000));
    await browser.close();

    return { email, password, birthDate: `${randomDay} ${randomMonth} ${randomYear}` };
};

// Fungsi untuk menampilkan tutorial lengkap
const showTutorial = async (chatId) => {
    const tutorialMessage = `🎬 <b>CAPCUT ACCOUNT CREATOR</b> 🎬\n\n` +
        `📚 <b>CARA MENGGUNAKAN:</b>\n\n` +
        `1️⃣ Ketik <code>/create</code> atau <code>/create 2</code>\n` +
        `2️⃣ Pilih jumlah akun (1-3)\n` +
        `3️⃣ Pilih password: Random atau Custom\n` +
        `4️⃣ Tunggu giliran dalam antrian\n` +
        `5️⃣ Dapatkan hasil: Email, Password, Tanggal lahir\n\n` +
        `🎯 <b>FITUR:</b>\n` +
        `✅ Akun CapCut otomatis\n` +
        `✅ Email temporary\n` +
        `✅ Password random/custom\n` +
        `✅ Verifikasi OTP otomatis\n` +
        `✅ Sistem antrian real-time\n\n` +
        `📝 <b>PERINTAH:</b>\n` +
        `• <code>/create</code> - Mulai membuat akun\n` +
        `• <code>/setpassword yourpass</code> - Set password custom\n` +
        `• <code>/clearpassword</code> - Reset ke password acak\n` +
        `• <code>/queue</code> - Lihat antrian\n` +
        `• <code>/help</code> - Bantuan\n\n` +
        `🚀 Ketik <code>/create</code> untuk mulai!`;

    await sendToTelegram(tutorialMessage, chatId);
};

// Fungsi untuk menampilkan menu pembuatan akun
const showCreateMenu = async (chatId) => {
    const createMessage = `🎬 <b>CAPCUT ACCOUNT CREATOR</b> 🎬\n\n` +
        `📝 Berapa banyak akun yang ingin dibuat? (1-3)`;

    const keyboard = [
        [
            { text: "1 Akun", callback_data: "create_1" },
            { text: "2 Akun", callback_data: "create_2" },
            { text: "3 Akun", callback_data: "create_3" }
        ],
        [
            { text: "📊 Antrian", callback_data: "queue" }
           
        ],
        [
            { text: "📚 Tutorial", callback_data: "tutorial" }
        ]
    ];

    await sendKeyboard(createMessage, keyboard, chatId);
};

// Fungsi untuk memproses callback query
const processCallbackQuery = async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;
    const username = callbackQuery.from.username || callbackQuery.from.first_name || 'User';

    // Hapus keyboard sebelumnya
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    } catch (error) {
        console.log('Tidak bisa menghapus keyboard');
    }

    if (data.startsWith('create_')) {
        const count = data.split('_')[1];
        
        if (count === 'custom') {
            await sendToTelegram('🔢 <b>Masukkan jumlah akun yang ingin dibuat (1-3):</b>\n\nContoh: <code>2</code>', chatId);
            return;
        }

        const totalAccounts = parseInt(count);
        if (isNaN(totalAccounts) || totalAccounts < 1 || totalAccounts > 3) {
            await sendToTelegram('❌ <b>Jumlah tidak valid!</b>\n\nSilakan pilih antara 1-3 akun.', chatId);
            return;
        }

        // Cek apakah user sudah ada di antrian
        const existingUser = queue.find(item => item.chatId === chatId);
        if (existingUser) {
            await sendToTelegram('⚠️ <b>Anda sudah ada di antrian!</b>\n\nTunggu giliran Anda selesai terlebih dahulu.', chatId);
            return;
        }

        // Minta user pilih mode password sebelum masuk antrian
        await promptPasswordChoice(chatId, username, totalAccounts);
        
    } else if (data === 'info') {
    } else if (data === 'pw_random') {
        // User memilih random: langsung masuk antrian tanpa override
        const pending = pendingPasswordSelection.get(chatId);
        if (!pending) {
            await sendToTelegram('⚠️ Permintaan tidak ditemukan. Ketik /create lagi.', chatId);
            return;
        }
        pendingPasswordSelection.delete(chatId);

        const queueItem = addToQueue(chatId, pending.username, pending.accountCount, null);
        const position = getQueuePosition(chatId);
        const queueMessageId = await sendQueueAnimation(chatId, position, queue.length);
        queueItem.messageId = queueMessageId;
        if (!isProcessing) {
            processQueue();
        }
    } else if (data === 'pw_custom') {
        // Minta user ketik password, set timeout 5 menit
        const pending = pendingPasswordSelection.get(chatId);
        if (!pending) {
            await sendToTelegram('⚠️ Permintaan tidak ditemukan. Ketik /create lagi.', chatId);
            return;
        }
        pending.waitingForPassword = true;

        // Set timeout 5 menit -> fallback ke random
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pending.timeoutId = setTimeout(async () => {
            const st = pendingPasswordSelection.get(chatId);
            if (!st) return;
            pendingPasswordSelection.delete(chatId);
            await sendToTelegram('⏳ Waktu 5 menit habis. Menggunakan password random.', chatId);
            const queueItem = addToQueue(chatId, st.username, st.accountCount, null);
            const position = getQueuePosition(chatId);
            const queueMessageId = await sendQueueAnimation(chatId, position, queue.length);
            queueItem.messageId = queueMessageId;
            if (!isProcessing) {
                processQueue();
            }
        }, 5 * 60 * 1000);

    
        
    } else if (data === 'tutorial') {
        await showTutorial(chatId);
    } else if (data === 'queue') {
        await showQueue(chatId);
    } else if (data === 'password_menu') {
        let statusText = '';
        if (customPassword) {
            statusText = `✅ <b>Mode:</b> Password Custom\n` +
                `🔑 <b>Password:</b> <code>${customPassword}</code>\n\n` +
                `📝 Semua akun baru akan menggunakan password ini`;
        } else {
            statusText = `🎲 <b>Mode:</b> Password Random\n` +
                `🔑 Password akan di-generate otomatis (8-12 karakter)\n\n` +
                `📝 Setiap akun akan mendapat password yang berbeda`;
        }
        
        const fullMessage = `🔑 <b>PENGATURAN PASSWORD</b>\n\n` + statusText + `\n\n` +
            `💡 <b>Perintah:</b>\n` +
            `• <code>/setpassword yourpass</code> - Set password custom\n` +
            `• <code>/clearpassword</code> - Reset ke password acak\n` +
            `• <code>/passwordstatus</code> - Cek status password\n\n` +
            `Ketik <code>/create</code> untuk membuat akun!`;
        
        await sendToTelegram(fullMessage, chatId);
    }
};

// Fungsi untuk memproses pesan teks
const processTextMessage = async (message) => {
    const chatId = message.chat.id;
    const text = message.text;
    const username = message.from.username || message.from.first_name || 'User';

    // Handle perintah /create
    if (text.startsWith('/create')) {
        const parts = text.split(' ');
        let totalAccounts = 1;
        
        // Cek apakah ada parameter jumlah akun
        if (parts.length > 1) {
            const count = parseInt(parts[1]);
            if (!isNaN(count) && count >= 1 && count <= 3) {
                totalAccounts = count;
            } else {
                await sendToTelegram('❌ <b>Jumlah tidak valid!</b>\n\nGunakan: <code>/create 3</code> (1-3)', chatId);
                return;
            }
        }

        // Cek apakah user sudah ada di antrian
        const existingUser = queue.find(item => item.chatId === chatId);
        if (existingUser) {
            await sendToTelegram('⚠️ <b>Anda sudah ada di antrian!</b>\n\nTunggu giliran Anda selesai terlebih dahulu.', chatId);
            return;
        }

        // Jika hanya /create tanpa parameter, tampilkan menu
        if (parts.length === 1) {
            await showCreateMenu(chatId);
            return;
        }

        // Prompt pemilihan password sebelum antrian
        await promptPasswordChoice(chatId, username, totalAccounts);
        return;
    }

    // Handle perintah /setpassword
    if (text.startsWith('/setpassword')) {
        const parts = text.split(' ');
        if (parts.length < 2) {
            await sendToTelegram('❌ <b>Format salah!</b>\n\nGunakan: <code>/setpassword yourpassword</code>\n\nContoh: <code>/setpassword mypassword123</code>', chatId);
            return;
        }
        
        const newPassword = parts.slice(1).join(' ');
        if (newPassword.length < 6) {
            await sendToTelegram('❌ <b>Password terlalu pendek!</b>\n\nPassword minimal 6 karakter.', chatId);
            return;
        }
        
        setCustomPassword(newPassword);
        await sendToTelegram(`✅ <b>Password custom berhasil diatur!</b>\n\n🔑 <b>Password baru:</b> <code>${newPassword}</code>\n\n📝 <b>Catatan:</b>\n• Semua akun baru akan menggunakan password ini\n• Ketik <code>/clearpassword</code> untuk kembali ke password acak`, chatId);
        return;
    }

    // Handle perintah /clearpassword
    if (text === '/clearpassword') {
        clearCustomPassword();
        await sendToTelegram('✅ <b>Password custom berhasil dihapus!</b>\n\n🔑 Sekarang bot akan menggunakan password acak untuk setiap akun baru.', chatId);
        return;
    }

    // Handle perintah /passwordstatus
    if (text === '/passwordstatus') {
        let statusMessage = '🔑 <b>STATUS PASSWORD</b>\n\n';
        
        if (customPassword) {
            statusMessage += `✅ <b>Mode:</b> Password Custom\n`;
            statusMessage += `🔑 <b>Password:</b> <code>${customPassword}</code>\n\n`;
            statusMessage += `📝 Semua akun baru akan menggunakan password ini\n`;
            statusMessage += `🔄 Untuk kembali ke random: <code>/clearpassword</code>`;
        } else {
            statusMessage += `🎲 <b>Mode:</b> Password Random\n`;
            statusMessage += `🔑 Password akan di-generate otomatis (8-12 karakter)\n\n`;
            statusMessage += `📝 Setiap akun akan mendapat password yang berbeda\n`;
            statusMessage += `⚙️ Untuk set custom: <code>/setpassword yourpassword</code>`;
        }
        
        await sendToTelegram(statusMessage, chatId);
        return;
    }

    // Handle perintah /help
    if (text === '/help') {
        const helpMessage = `🆘 <b>BANTUAN CEPAT</b>\n\n` +
            `📝 <b>Perintah:</b>\n` +
            `• <code>/create</code> - Mulai membuat akun\n` +
            `• <code>/create 3</code> - Buat 3 akun langsung\n` +
            `• <code>/setpassword yourpass</code> - Set password custom\n` +
            `• <code>/clearpassword</code> - Reset ke password acak\n` +
            `• <code>/queue</code> - Lihat antrian\n` +
            (isOwner(chatId) ? `• <code>/adminqueue</code> - Lihat semua antrian (owner)\n` : '') +
            `• <code>/help</code> - Bantuan ini\n\n` +
            `💡 <b>Tips:</b>\n` +
            `• Ketik angka (1-3) untuk jumlah akun\n` +
            `• Gunakan tombol untuk pilihan cepat\n` +
            `• Tunggu giliran dalam antrian\n\n` +
            `Ketik <code>/start</code> untuk tutorial lengkap!`;
        
        await sendToTelegram(helpMessage, chatId);
        return;
    }

    // Handle perintah /queue
    if (text === '/queue') {
        await showQueue(chatId);
        return;
    }

    // Owner: daftar pembuat
    if (text === '/adminusers') {
        if (!isOwner(chatId)) {
            await sendToTelegram('⛔ Perintah ini hanya untuk owner.', chatId);
            return;
        }
        if (creatorStats.size === 0) {
            await sendToTelegram('📇 Belum ada data pembuat akun.', chatId);
            return;
        }
        let msg = '📇 <b>ADMIN USERS</b>\n\n';
        for (const [uid, s] of creatorStats.entries()) {
            msg += `👤 ${s.username} (chatId: <code>${uid}</code>)\n` +
                   `• Diminta: ${s.totalRequested}\n` +
                   `• Berhasil: ${s.totalSuccess}\n` +
                   `• Gagal: ${s.totalFailed}\n` +
                   `• Terakhir: ${new Date(s.lastAt).toLocaleString('id-ID')}\n\n`;
        }
        await sendToTelegram(msg, chatId);
        return;
    }

    // Handle perintah /adminqueue (owner only)
    if (text === '/adminqueue') {
        if (!isOwner(chatId)) {
            await sendToTelegram('⛔ Perintah ini hanya untuk owner.', chatId);
            return;
        }
        let header = `🗂️ <b>ADMIN QUEUE</b>\n\n`;
        if (queue.length === 0) {
            await sendToTelegram(header + '✅ Tidak ada antrian saat ini.', chatId);
            return;
        }
        let list = '';
        queue.forEach((it, idx) => {
            const icon = it.status === 'processing' ? '🔄' : '⏳';
            const elapsed = Math.floor((new Date() - it.startTime) / 1000);
            list += `${icon} <b>${idx + 1}.</b> ${it.username} (chatId: <code>${it.chatId}</code>) — ${it.accountCount} akun — ${elapsed}s\n`;
        });
        await sendToTelegram(header + list, chatId);
        return;
    }

    // Cek apakah user sedang diminta mengetik password custom
    const pending = pendingPasswordSelection.get(chatId);
    if (pending && pending.waitingForPassword) {
        const pwd = text.trim();
        if (pwd.length < 6) {
            await sendToTelegram('❌ Password terlalu pendek. Minimal 6 karakter. Coba lagi.', chatId);
            return;
        }
        // Bersihkan timeout dan state, masuk antrian dengan override
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        pendingPasswordSelection.delete(chatId);
        const queueItem = addToQueue(chatId, pending.username, pending.accountCount, pwd);
        const position = getQueuePosition(chatId);
        const queueMessageId = await sendQueueAnimation(chatId, position, queue.length);
        queueItem.messageId = queueMessageId;
        if (!isProcessing) {
            processQueue();
        }
        await sendToTelegram('✅ Password custom diterima. Menambahkan ke antrian...', chatId);
        return;
    }

    // Cek apakah pesan adalah angka (untuk custom jumlah akun)
    if (/^\d+$/.test(text)) {
        const totalAccounts = parseInt(text);
        
        if (totalAccounts < 1 || totalAccounts > 3) {
            await sendToTelegram('❌ <b>Jumlah tidak valid!</b>\n\nSilakan masukkan angka antara 1-3.', chatId);
            return;
        }

        // Cek apakah user sudah ada di antrian
        const existingUser = queue.find(item => item.chatId === chatId);
        if (existingUser) {
            await sendToTelegram('⚠️ <b>Anda sudah ada di antrian!</b>\n\nTunggu giliran Anda selesai terlebih dahulu.', chatId);
            return;
        }

        // Prompt pemilihan password sebelum antrian
        await promptPasswordChoice(chatId, username, totalAccounts);
    } else {
        await sendToTelegram('❓ <b>Perintah tidak dikenali!</b>\n\nKetik <code>/start</code> untuk tutorial atau <code>/create</code> untuk membuat akun.', chatId);
    }
};

// Fungsi utama untuk menjalankan bot Telegram
const runTelegramBot = async () => {
    console.log(chalk.yellow.bold('\n🤖 CAPCUT TELEGRAM BOT STARTED! 🤖\n'));
    
    if (TELEGRAM_BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE' || TELEGRAM_CHAT_ID === 'YOUR_CHAT_ID_HERE') {
        console.log(chalk.red('❌ Konfigurasi Telegram belum diatur!'));
        console.log(chalk.cyan('📱 Silakan edit file config.js dan isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID'));
        process.exit(1);
    }

    let offset = 0;
    
    while (true) {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`);
            
            for (const update of response.data.result) {
                offset = update.update_id + 1;
                
                if (update.message) {
                    const message = update.message;
                    
                    if (message.text === '/start') {
                        await showTutorial(message.chat.id);
                    } else if (message.text) {
                        await processTextMessage(message);
                    }
                } else if (update.callback_query) {
                    await processCallbackQuery(update.callback_query);
                }
            }
        } catch (error) {
            console.error(chalk.red('❌ Error dalam bot Telegram:'), error.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

// Jalankan bot
runTelegramBot().catch(console.error);
