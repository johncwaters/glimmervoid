import { FAQ_ENTRIES } from './faq.ts';
import { AUTHOR, PRODUCT_SUMMARY, PRODUCT_VERSION, REPOSITORY_URL } from './product-facts.ts';

export const HOME_TITLE = 'Glimmervoid: orchestrator for terminal coding agents';

export function homeStructuredData(site: URL | undefined): Record<string, unknown> {
  const homeUrl = new URL('/', site).href;
  const authorId = `${homeUrl}#author`;
  return {
    '@graph': [
      { '@type': 'WebSite', name: 'Glimmervoid', url: homeUrl, publisher: { '@id': authorId } },
      { ...AUTHOR, '@id': authorId },
      {
        '@type': 'SoftwareApplication',
        name: 'Glimmervoid',
        url: homeUrl,
        description: PRODUCT_SUMMARY,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Windows, macOS, Linux',
        softwareVersion: PRODUCT_VERSION,
        license: 'https://opensource.org/licenses/MIT',
        sameAs: REPOSITORY_URL,
        author: { '@id': authorId },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ_ENTRIES.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
      },
    ],
  };
}
