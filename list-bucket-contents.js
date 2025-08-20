#!/usr/bin/env node

import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const BUCKET_NAME = "replit-objstore-2636b162-92a0-40e2-b468-2a1ee37ceefd";

// Create storage client with Replit authentication (same as objectStorage.ts)
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

async function listBucketContents() {
  try {
    console.log(`Listing contents of bucket: ${BUCKET_NAME}`);
    
    const bucket = storage.bucket(BUCKET_NAME);
    
    // Note: Skipping bucket metadata check due to permissions
    console.log("Attempting to list files...\n");
    
    // Check ALL files in the bucket (no prefix)
    console.log("Listing ALL files in the bucket...\n");
    const [allFiles] = await bucket.getFiles({
      maxResults: 100
    });

    console.log("All files in bucket:");
    console.log("=".repeat(50));
    
    if (allFiles.length === 0) {
      console.log("Bucket is completely empty.");
      return;
    }

    allFiles.forEach((file, index) => {
      const name = file.name;
      const sizeStr = file.metadata.size ? `${Math.round(file.metadata.size / 1024)}KB` : "unknown size";
      const dateStr = file.metadata.updated ? new Date(file.metadata.updated).toLocaleDateString() : "unknown date";
      console.log(`${index + 1}. 📄 ${name} (${sizeStr}, ${dateStr})`);
    });

    // Now specifically look in the "public" directory
    console.log(`\nFiltering for "public" directory contents...\n`);
    
    const publicFiles = allFiles.filter(file => file.name.startsWith("public/"));

    console.log("Public directory contents:");
    console.log("=".repeat(40));

    if (publicFiles.length === 0) {
      console.log("No files found in the public directory.");
      return;
    }

    // Group files by their immediate parent directory under public/
    const items = new Map();
    
    publicFiles.forEach(file => {
      const name = file.name;
      
      // Remove "public/" prefix
      const relativePath = name.replace(/^public\//, "");
      
      if (relativePath === "") {
        // This is the public/ directory itself
        return;
      }
      
      // Check if this is a direct file in public/ or in a subdirectory
      const pathParts = relativePath.split("/");
      
      if (pathParts.length === 1) {
        // Direct file in public/
        items.set(name, {
          type: "file",
          name: relativePath,
          size: file.metadata.size,
          updated: file.metadata.updated
        });
      } else {
        // File in subdirectory
        const dirName = pathParts[0];
        const dirKey = `public/${dirName}/`;
        
        if (!items.has(dirKey)) {
          items.set(dirKey, {
            type: "directory",
            name: `${dirName}/`,
            fileCount: 0
          });
        }
        
        items.get(dirKey).fileCount++;
      }
    });

    // Sort items: directories first, then files
    const sortedItems = Array.from(items.values()).sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    sortedItems.forEach(item => {
      if (item.type === "directory") {
        console.log(`📁 ${item.name} (${item.fileCount} files)`);
      } else {
        const sizeStr = item.size ? `${Math.round(item.size / 1024)}KB` : "unknown size";
        const dateStr = item.updated ? new Date(item.updated).toLocaleDateString() : "unknown date";
        console.log(`📄 ${item.name} (${sizeStr}, ${dateStr})`);
      }
    });

    console.log(`\nTotal items: ${sortedItems.length}`);

  } catch (error) {
    console.error("Error listing bucket contents:", error.message);
    
    if (error.message.includes("credentials")) {
      console.error("\nAuthentication error. Make sure you're running this on Replit with proper object storage access.");
    } else if (error.message.includes("404")) {
      console.error("\nBucket not found. Please verify the bucket name is correct.");
    }
  }
}

// Run the script
listBucketContents();