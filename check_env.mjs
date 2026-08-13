import dotenv from 'dotenv';
dotenv.config();

console.log("META_ACCESS_TOKEN length:", process.env.META_ACCESS_TOKEN ? process.env.META_ACCESS_TOKEN.length : 0);
console.log("META_ACCESS_TOKEN:", process.env.META_ACCESS_TOKEN);
