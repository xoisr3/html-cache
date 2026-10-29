import { Article } from '../../../../components.jsx';
import { findDocument } from '../../../../content.js';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [{ group: 'xa-hoi', topic: 'giao-duc', slug: 'tuyen-sinh' }];
}

export async function generateMetadata({ params }) {
  const { group, topic, slug } = await params;
  const page = findDocument(`/chuyen-muc/${group}/${topic}/${slug}`);
  return { other: { 'hiden-cache-revision': page.revision } };
}

export default async function CategoryArticlePage({ params }) {
  const { group, topic, slug } = await params;
  const page = findDocument(`/chuyen-muc/${group}/${topic}/${slug}`);
  return <Article heading={page.heading} body={page.body} crumbs={page.crumbs} />;
}
