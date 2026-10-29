export const documents = [
  {
    path: '/',
    revision: 'listing:v1',
    heading: 'Trang chu',
    summary: 'Danh sach muc chinh.',
    crumbs: [{ href: '/', label: 'Tin tuc' }],
    links: [
      { href: '/tin-tuc/the-gioi', label: 'The gioi' },
      { href: '/tin-tuc/the-gioi/kinh-te/bai-viet-a', label: 'Kinh te tuan nay' },
      { href: '/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh', label: 'Tuyen sinh' },
    ],
  },
  {
    path: '/tin-tuc/a',
    revision: 'article-a:v1',
    heading: 'Bai a',
    body: 'Noi dung bai a.',
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/tin-tuc/a', label: 'Bai a' },
    ],
  },
  {
    path: '/tin-tuc/the-gioi',
    revision: 'section:the-gioi:v1',
    heading: 'The gioi',
    summary: 'Cac chu de the gioi.',
    links: [{ href: '/tin-tuc/the-gioi/kinh-te', label: 'Kinh te' }],
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/tin-tuc/the-gioi', label: 'The gioi' },
    ],
  },
  {
    path: '/tin-tuc/the-gioi/kinh-te',
    revision: 'topic:kinh-te:v1',
    heading: 'Kinh te',
    summary: 'Bai viet kinh te.',
    links: [{ href: '/tin-tuc/the-gioi/kinh-te/bai-viet-a', label: 'Kinh te tuan nay' }],
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/tin-tuc/the-gioi', label: 'The gioi' },
      { href: '/tin-tuc/the-gioi/kinh-te', label: 'Kinh te' },
    ],
  },
  {
    path: '/tin-tuc/the-gioi/kinh-te/bai-viet-a',
    revision: 'article:bai-viet-a:v1',
    heading: 'Kinh te tuan nay',
    body: 'Noi dung bai viet kinh te o muc sau.',
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/tin-tuc/the-gioi', label: 'The gioi' },
      { href: '/tin-tuc/the-gioi/kinh-te', label: 'Kinh te' },
      { href: '/tin-tuc/the-gioi/kinh-te/bai-viet-a', label: 'Kinh te tuan nay' },
    ],
  },
  {
    path: '/tin-tuc/the-gioi/kinh-te/trang/2',
    revision: 'listing:kinh-te:page-2',
    heading: 'Kinh te trang 2',
    summary: 'Trang so 2 cua kinh te.',
    links: [{ href: '/tin-tuc/the-gioi/kinh-te/bai-viet-a', label: 'Kinh te tuan nay' }],
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/tin-tuc/the-gioi/kinh-te', label: 'Kinh te' },
      { href: '/tin-tuc/the-gioi/kinh-te/trang/2', label: 'Trang 2' },
    ],
  },
  {
    path: '/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh',
    revision: 'article:tuyen-sinh:v1',
    heading: 'Tuyen sinh',
    body: 'Noi dung tuyen sinh giao duc.',
    crumbs: [
      { href: '/', label: 'Tin tuc' },
      { href: '/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh', label: 'Tuyen sinh' },
    ],
  },
];

export function findDocument(urlPath) {
  return documents.find((document) => document.path === urlPath);
}
