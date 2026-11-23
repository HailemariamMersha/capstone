import { ResearchApp } from '@/components/research-app';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResearchApp section="trips" tripId={id} />;
}
