import { Listing } from './components.jsx';
import { findDocument } from './content.js';

export const dynamic = 'force-static';

const page = findDocument('/');

export const metadata = {
  other: {
    'hiden-cache-revision': page.revision,
  },
};

export default function HomePage() {
  return <Listing heading={page.heading} summary={page.summary} links={page.links} crumbs={page.crumbs} />;
}
