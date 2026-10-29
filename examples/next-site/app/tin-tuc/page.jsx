export async function generateMetadata({ searchParams }) {
  const { page = '1' } = await searchParams;
  return {
    other: {
      'hiden-cache-revision': `listing:query-${page}`,
    },
  };
}

export default async function QueryListingPage({ searchParams }) {
  const { page = '1' } = await searchParams;
  return (
    <main>
      <h1>Query {page}</h1>
    </main>
  );
}
