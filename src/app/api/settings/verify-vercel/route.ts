import { NextResponse } from 'next/server';

interface VerifyRequest {
  token: string;
  teamId?: string;
}

export async function POST(request: Request) {
  try {
    const { token, teamId } = await request.json() as VerifyRequest;

    if (!token) {
      return NextResponse.json(
        { valid: false, error: 'Token is required' },
        { status: 400 }
      );
    }

    // Test the token by fetching user info from Vercel API
    const url = teamId
      ? `https://api.vercel.com/v2/teams/${teamId}`
      : 'https://api.vercel.com/v2/user';

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      return NextResponse.json({
        valid: true,
        user: teamId ? data.name : data.user?.username,
      });
    } else {
      const error = await response.json();
      return NextResponse.json({
        valid: false,
        error: error.error?.message || 'Invalid token or team ID',
      });
    }
  } catch (error) {
    console.error('Failed to verify Vercel token:', error);
    return NextResponse.json(
      { valid: false, error: 'Failed to verify token' },
      { status: 500 }
    );
  }
}
