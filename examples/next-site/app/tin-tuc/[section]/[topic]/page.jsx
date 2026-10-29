import { Listing } from '../../../components.jsx';
import { findDocument } from '../../../content.js';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [{ section: 'the-gioi', topic: 'kinh-te' }];
}

export async function generateMetadata({ params }) {
  const { section, topic } = await params;
  const page = findDocument(`/tin-tuc/${section}/${topic}`);
  return { other: { 'hiden-cache-revision': page.revision } };
}

export default async function TopicPage({ params }) {
  const { section, topic } = await params;
  const page = findDocument(`/tin-tuc/${section}/${topic}`);
  return <Listing heading={page.heading} summary={page.summary} links={page.links} crumbs={page.crumbs} />;
}
