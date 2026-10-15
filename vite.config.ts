import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
export default defineConfig({ server: { watch: { ignored: ['**/.player-two/**', '**/docs/**'] } }, plugins: [tailwindcss(), sveltekit()] });
