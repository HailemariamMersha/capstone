'use client';
import { useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { RadioTower, CircleUserRound } from 'lucide-react';
import { api, configured, supabase } from '@/lib/client';
import { Button } from './ui/button';
import {
  TripWorkspace,
  Message as Notice,
  type Profile,
  type Section,
} from './trip-workspace';
function Entry({
  section = 'overview',
  tripId,
}: {
  section?: Section;
  tripId?: string;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const client = useQueryClient();
  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedIn(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSignedIn(Boolean(s));
      if (!s) client.clear();
    });
    return () => data.subscription.unsubscribe();
  }, [client]);
  const profile = useQuery<Profile>({
    queryKey: ['profile'],
    queryFn: () => api('/profile'),
    enabled: signedIn === true,
    retry: false,
  });
  if (signedIn === null)
    return (
      <main className="p-12">
        <Notice>Opening research workspace…</Notice>
      </main>
    );
  if (
    signedIn &&
    profile.data &&
    ['researcher', 'administrator'].includes(profile.data.role)
  )
    return (
      <TripWorkspace profile={profile.data} section={section} tripId={tripId} />
    );
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="panel max-w-xl p-10 md:p-14 space-y-7">
        <RadioTower className="text-teal-800" size={40} />
        <p className="text-xs tracking-widest font-semibold text-teal-800">
          SKYMEASURE RESEARCH
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">
          Every journey has a signal.
        </h1>
        <p className="muted text-lg">
          A private workspace for the team studying how our networks connect
          people on the move.
        </p>
        {signedIn ? (
          <>
            <Notice error={Boolean(profile.error)}>
              {profile.error?.message ??
                (profile.isPending
                  ? 'Checking research access…'
                  : `Researcher access is required. Give your administrator this participant identifier: ${profile.data?.participantId}`)}
            </Notice>
            <Button
              variant="outline"
              onClick={() => supabase.auth.signOut({ scope: 'local' })}
            >
              Sign out
            </Button>
          </>
        ) : (
          <Button
            disabled={!configured}
            onClick={async () => {
              if (/^\/trips\/[a-f0-9]{32}$/.test(window.location.pathname))
                sessionStorage.setItem(
                  'skymeasure.returnTo',
                  window.location.pathname,
                );
              const { error: e } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                  redirectTo: `${window.location.origin}/auth/callback`,
                },
              });
              if (e)
                setError('Could not start Google sign-in. Please try again.');
            }}
          >
            <CircleUserRound size={18} />
            Continue with Google
          </Button>
        )}
        {!configured && (
          <Notice>
            Staging services are not configured yet. Follow the repository setup
            guide before inviting participants.
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        <p className="text-xs muted">
          Access is limited to approved researchers. Signing up does not grant
          access to research data.
        </p>
      </div>
    </main>
  );
}

export function ResearchProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10000, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export function ResearchApp({
  section = 'overview',
  tripId,
}: {
  section?: Section;
  tripId?: string;
}) {
  return <Entry section={section} tripId={tripId} />;
}
