import { handle } from 'hono/vercel';
import { createApp } from '../server/app.js';

/**
 * Vercel Node function. Dùng HTTP driver của Neon nên không giữ kết nối nào
 * giữa các request — cold start chỉ còn là thời gian bật function.
 */
const app = createApp();

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);

export default app;
