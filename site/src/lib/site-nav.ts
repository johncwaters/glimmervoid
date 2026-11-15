import { REPOSITORY_URL } from './product-facts.ts';
import { sitePath } from './site-path.ts';

export function siteNavLinks(homePagePath: string): { label: string; href: string }[] {
  return [
    { label: 'Boards', href: `${homePagePath}#boards` },
    { label: 'Sane YOLO', href: `${homePagePath}#sane-yolo` },
    { label: 'Blog', href: sitePath('blog/') },
    { label: 'Changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
    { label: 'GitHub', href: REPOSITORY_URL },
  ];
}
