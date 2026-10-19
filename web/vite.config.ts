import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const apiTarget = env.VITE_DEV_API_TARGET ?? 'http://localhost:3000';

    return {
        plugins: [react()],
        server: {
            port: 5173,
            // Proxy en desarrollo: el navegador habla siempre con el mismo origen,
            // asi que no hay CORS ni preflight. `/health` se incluye porque, sin
            // el, el fallback SPA de Vite responde index.html en vez de la API.
            proxy: {
                '/api': { target: apiTarget, changeOrigin: true },
                '/health': { target: apiTarget, changeOrigin: true },
                '/docs': { target: apiTarget, changeOrigin: true },
            },
        },
        build: {
            outDir: 'dist',
            sourcemap: true,
        },
    };
});
