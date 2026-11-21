import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'UpgradeLab',
  description: 'Prove that software upgrades preserve user data.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Concepts', link: '/concepts/verdicts' },
      { text: 'Configuration', link: '/configuration/reference' },
      { text: 'Reference', link: '/reference/cli' },
    ],
    sidebar: {
      '/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is UpgradeLab?', link: '/' },
            { text: 'Getting started', link: '/getting-started' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Verdicts and exit codes', link: '/concepts/verdicts' },
            { text: 'How a run works', link: '/concepts/how-runs-work' },
          ],
        },
        {
          text: 'Configuration',
          items: [
            { text: 'Configuration reference', link: '/configuration/reference' },
            { text: 'Schema migrations', link: '/configuration/migration' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'GitHub Actions', link: '/guides/github-actions' },
            { text: 'Plugins', link: '/guides/plugins' },
            { text: 'AI diagnostics', link: '/guides/ai-diagnostics' },
            { text: 'Troubleshooting', link: '/guides/troubleshooting' },
          ],
        },
        {
          text: 'Security',
          items: [{ text: 'Hardening Compose files', link: '/security/compose-hardening' }],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Report schema', link: '/reference/report-schema' },
            { text: 'Architecture decisions', link: '/adr/' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/upgradelab/upgradelab' }],
    editLink: {
      pattern: 'https://github.com/upgradelab/upgradelab/edit/main/docs/:path',
      text: 'Edit this page',
    },
    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright UpgradeLab contributors',
    },
  },
});
