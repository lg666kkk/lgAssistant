const text = process.argv.slice(2).join(" ");
const lines = text ? text.split(/\r?\n/).length : 0;
const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
const characters = Array.from(text).length;

console.log(JSON.stringify({ characters, words, lines }));
