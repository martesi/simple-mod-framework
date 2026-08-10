/** @type {import("@lingui/conf").LinguiConfig} */
export default {
  locales: ['en-US'],
  sourceLocale: 'en-US',
  catalogs: [
    {
      path: 'src/renderer/src/locales/{locale}/messages',
      include: ['src/renderer/src'],
    },
  ],
}
