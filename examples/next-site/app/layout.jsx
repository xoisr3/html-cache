export const metadata = {
  title: 'Tin tuc',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi" data-dpl-id="next-dev">
      <body>{children}</body>
    </html>
  );
}
