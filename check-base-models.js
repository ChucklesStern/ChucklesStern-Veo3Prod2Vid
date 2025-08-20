#!/usr/bin/env node

/**
 * Script to check if base model images exist in object storage
 */

import { ObjectStorageService } from './server/objectStorage.ts';

async function checkBaseModelImages() {
    console.log('🔍 Checking base model images in object storage...\n');
    
    const objectStorage = new ObjectStorageService();
    
    // The paths from the .env file (relative to public-objects endpoint)
    const baseModelPaths = [
        'base model/basemodel.png',
        'base model/basemodel2.png'
    ];
    
    console.log('📍 Object storage configuration:');
    try {
        const publicPaths = objectStorage.getPublicObjectSearchPaths();
        console.log(`   Public search paths: ${publicPaths.join(', ')}`);
    } catch (error) {
        console.error(`   ❌ Error getting public paths: ${error.message}`);
        return;
    }
    console.log();
    
    const results = [];
    
    for (const [index, filePath] of baseModelPaths.entries()) {
        const imageNumber = index + 1;
        console.log(`🖼️  Checking BASE_MODEL_IMAGE_${imageNumber}: ${filePath}`);
        
        try {
            const file = await objectStorage.searchPublicObject(filePath);
            
            if (file) {
                console.log(`   ✅ FOUND: ${filePath}`);
                
                // Get additional metadata
                try {
                    const [metadata] = await file.getMetadata();
                    console.log(`   📊 Size: ${metadata.size} bytes`);
                    console.log(`   📝 Content-Type: ${metadata.contentType}`);
                    console.log(`   📅 Updated: ${metadata.updated}`);
                } catch (metaError) {
                    console.log(`   ⚠️  Could not get metadata: ${metaError.message}`);
                }
                
                results.push({ path: filePath, exists: true, file });
            } else {
                console.log(`   ❌ NOT FOUND: ${filePath}`);
                results.push({ path: filePath, exists: false, file: null });
            }
        } catch (error) {
            console.log(`   💥 ERROR checking ${filePath}: ${error.message}`);
            results.push({ path: filePath, exists: false, error: error.message });
        }
        
        console.log(); // Empty line for readability
    }
    
    // Summary
    console.log('📋 SUMMARY:');
    console.log('='.repeat(50));
    
    const foundCount = results.filter(r => r.exists).length;
    const totalCount = results.length;
    
    results.forEach((result, index) => {
        const imageNumber = index + 1;
        const status = result.exists ? '✅ EXISTS' : '❌ MISSING';
        console.log(`   BASE_MODEL_IMAGE_${imageNumber}: ${status}`);
        if (result.error) {
            console.log(`     Error: ${result.error}`);
        }
    });
    
    console.log();
    console.log(`📊 Result: ${foundCount}/${totalCount} base model images found`);
    
    if (foundCount === totalCount) {
        console.log('🎉 All base model images are present in object storage!');
        process.exit(0);
    } else {
        console.log('⚠️  Some base model images are missing from object storage.');
        process.exit(1);
    }
}

// Run the check
checkBaseModelImages().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
});