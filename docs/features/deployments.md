# Deployments

HexOps integrates with Vercel for deploying your projects.

## Setup

### 1. Get Vercel Token

1. Go to [Vercel Account Tokens](https://vercel.com/account/tokens)
2. Click "Create Token"
3. Give it a name (e.g., "HexOps")
4. Set scope (all projects or specific)
5. Copy the token

### 2. Configure in HexOps

1. Go to Settings (`/settings`)
2. Open Vercel Integration section
3. Paste your API token
4. Optionally add Team ID for team accounts
5. Click "Verify Connection"
6. Save settings

### 3. Link Projects

For each project you want to deploy:

1. Open project detail page
2. Go to Settings section
3. Enter Vercel Project ID

**Finding Project ID:**
```bash
cd /path/to/project
cat .vercel/project.json
# Look for "projectId": "prj_xxxx"
```

If not linked yet:
```bash
vercel link
```

## Deploying

### From Project Detail

1. Open the project detail page
2. Find the Vercel section
3. Click "Deploy Preview" or "Deploy Production"

### Deploy Options

| Option | Description |
|--------|-------------|
| Preview | Deploys to a unique preview URL |
| Production | Deploys to your production domain |

### Deployment Status

After triggering a deploy:
- Status shows "Deploying..."
- On success, shows deployment URL
- On failure, shows error message

## Vercel Section Information

When connected, the Vercel section shows:

- **Project Name** - Vercel project name
- **Latest Deployment** - Most recent deployment status
- **URL** - Production URL
- **Status** - Ready, Building, Error

## Automatic Deployments

Vercel can auto-deploy on git push. Configure in Vercel dashboard:

1. Go to Project Settings in Vercel
2. Set up Git integration
3. Configure branch deployments

HexOps shows the latest deployment regardless of trigger source.

## Troubleshooting

### Token Invalid

If verification fails:
1. Check token is copied correctly
2. Verify token hasn't expired
3. Ensure token has correct scope

### Project Not Found

If project shows as not linked:
1. Verify Project ID is correct
2. Run `vercel link` in project directory
3. Check `.vercel/project.json` exists

### Deploy Fails

If deployment fails:
1. Check Vercel dashboard for error details
2. Verify build command works locally
3. Check environment variables are set

### Team Access

For team projects:
1. Add Team ID in settings
2. Ensure token has team access
3. Verify project is in the team

## API Integration

HexOps uses the Vercel API:

- List projects: `GET /v9/projects`
- Get project: `GET /v9/projects/{id}`
- Create deployment: `POST /v13/deployments`
- List deployments: `GET /v6/deployments`

Requires token with appropriate scopes.
