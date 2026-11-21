import express from 'express';
import { createApiApp } from './app.ts';

const app: express.Express = createApiApp();

export default app;
