import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Always load server/.env, no matter which folder the server was started from
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import analyseRouter from './routes.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', analyseRouter);

const { PORT = 5000, MONGO_URI } = process.env;
mongoose.connect(MONGO_URI || 'mongodb://127.0.0.1:27017/repo-analyser', { serverSelectionTimeoutMS: 3000 })
  .then(() => console.log('MongoDB connected (caching on)'))
  .catch(() => console.warn('MongoDB unavailable - running without cache'));
console.log(process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN: loaded' : 'GITHUB_TOKEN: missing (repo finder is limited to 10 searches/min and 60 README reads/hour; add one in server/.env)');
console.log(`GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'loaded' : 'MISSING (check server/.env)'}`);
app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
