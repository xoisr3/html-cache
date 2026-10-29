import Link from 'next/link';

export function SiteFrame({ children }) {
  return (
    <>
      <header>
        <Link href="/">Tin tuc</Link>
        <nav>
          <Link href="/tin-tuc/the-gioi">The gioi</Link>
          <Link href="/chuyen-muc/xa-hoi/giao-duc/tuyen-sinh">Giao duc</Link>
        </nav>
      </header>
      {children}
      <footer>Ban quyen</footer>
    </>
  );
}

export function Breadcrumb({ items }) {
  return (
    <nav aria-label="breadcrumb">
      {items.map((item) => (
        <Link key={item.href} href={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function Article({ heading, body, crumbs }) {
  return (
    <SiteFrame>
      <Breadcrumb items={crumbs} />
      <article>
        <h1>{heading}</h1>
        <p>{body}</p>
      </article>
    </SiteFrame>
  );
}

export function Listing({ heading, summary, links, crumbs }) {
  return (
    <SiteFrame>
      <Breadcrumb items={crumbs} />
      <section>
        <h1>{heading}</h1>
        <p>{summary}</p>
        <ul>
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href}>{link.label}</Link>
            </li>
          ))}
        </ul>
      </section>
    </SiteFrame>
  );
}
