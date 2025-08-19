# User Access Control Setup Guide

Your video generation portal now has user access control implemented. Here's how to manage user access:

## Default Behavior

- **Anyone with a Replit account can sign in** to your app
- **New users are NOT approved by default** - they will see an "Access denied" message
- **Only approved users can access the video generation features**

## Setting Up Your First Admin

Since new users aren't approved by default, you need to manually set up your first admin in the database:

### Option 1: Using the Database Tool (Recommended)
1. Go to the "Database" tab in your Replit project
2. Connect to your PostgreSQL database
3. Run this SQL command to make yourself an admin:
   ```sql
   UPDATE users 
   SET is_approved = true, is_admin = true 
   WHERE email = 'your-email@domain.com';
   ```

### Option 2: Using SQL Tool in Replit
1. Sign in to your app first (this creates your user record)
2. Use the SQL execution tool with:
   ```sql
   UPDATE users 
   SET is_approved = true, is_admin = true 
   WHERE id = 'YOUR_REPLIT_USER_ID';
   ```

## Managing Users (Admin Features)

Once you're an admin, you can:

### Approve/Deny Users
- GET `/api/admin/users` - View all users
- PUT `/api/admin/users/:id/approve` - Approve/deny user access
  ```json
  { "isApproved": true }
  ```

### Grant/Revoke Admin Access
- PUT `/api/admin/users/:id/admin` - Make user admin
  ```json
  { "isAdmin": true }
  ```

## User Experience

### For New Users
1. Signs in with Replit account
2. Sees "Access denied" message
3. Must wait for admin approval

### For Approved Users
1. Signs in with Replit account
2. Full access to video generation portal
3. Can upload images and create videos

### For Admins
1. Everything approved users can do
2. Additional admin panel access (if you build one)
3. Can approve/deny users via API

## Adding an Admin Panel (Optional)

You can create an admin interface in your React app that:
- Lists all users with their approval status
- Allows admins to approve/deny users with buttons
- Shows user registration dates and activity

## Security Notes

- All video generation endpoints require approval
- Admin functions require admin role
- Session-based authentication with PostgreSQL storage
- Automatic user creation from Replit OAuth claims

## Production Deployment

This access control system works automatically in production:
- No additional configuration needed
- Same database and user management
- Secure session handling maintained