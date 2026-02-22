import { Database } from 'bun:sqlite';
const sqlite = new Database('./data/bot.db');
const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type='table';").all();
console.log("Tables in bot.db:", tables);
