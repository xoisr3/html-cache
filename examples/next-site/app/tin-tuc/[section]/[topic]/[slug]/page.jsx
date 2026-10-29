import { Article } from '../../../../components.jsx';
import { findDocument } from '../../../../content.js';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [{ section: 'the-gioi', topic: 'kinh-te', slug: 'bai-viet-a' }];
}

export async function generateMetadata({ params }) {
  const { section, topic, slug } = await params;
  const page = findDocument(`/tin-tuc/${section}/${topic}/${slug}`);
  return { other: { 'hiden-cache-revision': page.revision } };
}

export default async function DeepArticlePage({ params }) {
  const { section, topic, slug } = await params;
  const page = findDocument(`/tin-tuc/${section}/${topic}/${slug}`);
  return <Article heading={page.heading} body={page.body} crumbs={page.crumbs} />;
}
