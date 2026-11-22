import { ACCOUNT_PAGE_URL, REPOSITORY_URL } from './product-facts.ts';

export function siteNavLinks(homePagePath: string): { label: string; href: string }[] {
  return [
    { label: 'Boards', href: `${homePagePath}#boards` },
    { label: 'Cloud', href: `${homePagePath}#cloud` },
    { label: 'Changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
    { label: 'GitHub', href: REPOSITORY_URL },
    { label: 'Sign in', href: ACCOUNT_PAGE_URL },
  ];
}
