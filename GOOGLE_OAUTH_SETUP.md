# Google OAuth Setup Guide

## Step 1: Access Google Cloud Console
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Sign in with your Google account

## Step 2: Create or Select a Project
1. Click on the project dropdown at the top of the page
2. Either select an existing project or click "New Project"
3. If creating new: Enter a project name (e.g., "Video Generation Portal")
4. Click "Create"

## Step 3: Enable Google+ API
1. In the left sidebar, go to "APIs & Services" > "Library"
2. Search for "Google+ API" 
3. Click on it and press "Enable"
4. Alternatively, search for "People API" which is the newer version

## Step 4: Create OAuth 2.0 Credentials
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client IDs"
3. If prompted, configure the OAuth consent screen first:
   - Choose "External" user type
   - Fill in required fields (App name, User support email, Developer contact)
   - Add your domain if you have one
   - For scopes, add: email, profile, openid

## Step 5: Configure OAuth Client
1. For "Application type", select "Web application"
2. Give it a name (e.g., "Video Portal Auth")
3. Under "Authorized redirect URIs", add your callback URL (see below for exact URL)
4. Click "Create"

### Your Exact Callback URL
Run this command in your Replit shell to get your exact URL:
```bash
echo "https://$REPLIT_DEV_DOMAIN/api/auth/google/callback"
```

**Important Domain Formats (2024):**
- Development: `https://[random-id].replit.dev/api/auth/google/callback`
- Production (after deployment): `https://your-app.replit.app/api/auth/google/callback`

## Step 6: Get Your Credentials
1. Copy the "Client ID" - this is your `GOOGLE_CLIENT_ID`
2. Copy the "Client Secret" - this is your `GOOGLE_CLIENT_SECRET`

## Step 7: Add to Replit
1. In your Replit project, go to the Secrets tab (lock icon in sidebar)
2. Add these environment variables:
   - Key: `GOOGLE_CLIENT_ID`, Value: [your client id]
   - Key: `GOOGLE_CLIENT_SECRET`, Value: [your client secret]

## Important Notes
- Keep your Client Secret private and secure
- The redirect URI must exactly match what you configure in Google Cloud Console
- Your Replit URL format is typically: `https://projectname-username.replit.dev`

## For Development/Testing
If you're still developing and your Replit URL isn't finalized, you can temporarily use:
- `http://localhost:5000/api/auth/google/callback` for local testing
- Update it to your actual Replit URL when deploying

Once you add these credentials to your Replit secrets, restart your application and Google authentication will work!