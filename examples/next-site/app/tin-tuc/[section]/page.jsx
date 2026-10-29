import { Listing } from '../../components.jsx';
import { findDocument } from '../../content.js';

export const dynamic = 'force-static';

export function generateStaticParams() {
  return [{ section: 'the-gioi' }];
}

export async function generateMetadata({ params }) {
  const { section } = await params;
  const page = findDocument(`/tin-tuc/${section}`);
  return { other: { 'hiden-cache-revision': page.revision } };
}

export default async function SectionPage({ params }) {
  const { section } = await params;
  const page = findDocument(`/tin-tuc/${section}`);
  return <Listing heading={page.heading} summary={page.summary} links={page.links} crumbs={page.crumbs} />;
}
