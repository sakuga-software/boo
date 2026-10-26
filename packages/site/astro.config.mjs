// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// GitHub Pages serves the site of the repository under /boo.
export default defineConfig({
  site: 'https://sakuga-software.github.io',
  base: '/boo',
  integrations: [
    starlight({
      title: 'boo',
      description: 'The control tower for the pull requests of your coding agents.',
      logo: { src: './src/assets/ghost.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sakuga-software/boo' }],
      editLink: { baseUrl: 'https://github.com/sakuga-software/boo/edit/main/packages/site/' },
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        { label: 'Start', items: ['getting-started'] },
        { label: 'Agents', items: ['agents', 'automation', 'merge-policy'] },
        { label: 'Reference', items: ['the-list', 'reviewers', 'quotas', 'settings', 'keys'] },
        { label: 'Project', items: ['contributing'] },
      ],
    }),
  ],
});
