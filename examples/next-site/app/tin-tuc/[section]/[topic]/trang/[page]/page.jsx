import { Listing } from '../../../../../components.jsx';
import { findDocument } from '../../../../../content.js';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [{ section: 'the-gioi', topic: 'kinh-te', page: '2' }];
}

export async function generateMetadata({ params }) {
  const { section, topic, page } = await params;
  const document = findDocument(`/tin-tuc/${section}/${topic}/trang/${page}`);
  return { other: { 'hiden-cache-revision': document.revision } };
}

export default async function TopicListingPage({ params }) {
  const { section, topic, page } = await params;
  const document = findDocument(`/tin-tuc/${section}/${topic}/trang/${page}`);
  return <Listing heading={document.heading} summary={document.summary} links={document.links} crumbs={document.crumbs} />;
}
