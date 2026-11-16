import { CLOUD_SIGNUP_OPEN } from 'astro:env/server';
import { ACCOUNT_PAGE_URL, REPOSITORY_URL } from './product-facts.ts';
import { sitePath } from './site-path.ts';

export function siteNavLinks(homePagePath: string): { label: string; href: string }[] {
  const accountLinks = CLOUD_SIGNUP_OPEN ? [{ label: 'Sign in', href: ACCOUNT_PAGE_URL }] : [];
  return [
    { label: 'Boards', href: `${homePagePath}#boards` },
    { label: 'Sane YOLO', href: `${homePagePath}#sane-yolo` },
    { label: 'Blog', href: sitePath('blog/') },
    { label: 'Changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
    { label: 'GitHub', href: REPOSITORY_URL },
    ...accountLinks,
  ];
}
