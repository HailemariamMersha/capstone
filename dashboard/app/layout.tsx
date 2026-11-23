import type { Metadata } from 'next';
import './globals.css';
import { ResearchProviders } from '@/components/research-app';
export const metadata: Metadata = {
  title: 'SkyMeasure · Research workspace',
  description: 'Private network measurement research workspace',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ResearchProviders>{children}</ResearchProviders>
      </body>
    </html>
  );
}
