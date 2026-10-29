import { Article } from '../../components.jsx';
import { findDocument } from '../../content.js';

export const dynamic = 'force-static';

const page = findDocument('/tin-tuc/a');

export const metadata = {
  other: {
    'hiden-cache-revision': page.revision,
  },
};

export default function ShortArticlePage() {
  return <Article heading={page.heading} body={page.body} crumbs={page.crumbs} />;
}
