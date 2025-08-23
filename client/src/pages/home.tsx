import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { Video, Lightbulb, Play, ExternalLink, Upload } from "lucide-react";
import { AuthButton } from "@/components/AuthButton";
import { GenerationStatusManager } from "@/components/GenerationStatusManager";
import { FloatingStatusPanel } from "@/components/FloatingStatusPanel";
import { NotificationSettings } from "@/components/NotificationSettings";
import { useNotificationSound } from "@/lib/notification-sound";
import type { VideoGeneration } from "@shared/schema";

const formSchema = z.object({
  promptText: z.string().min(1, "Product description is required"),
  brand_persona: z.string().optional()
});

type FormData = z.infer<typeof formSchema>;

export default function Home() {
  const [uploadedImage, setUploadedImage] = useState<{ path: string; url: string } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { initialize } = useNotificationSound();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      promptText: "",
      brand_persona: "Any images that you create should make use of our brand persona named Ayesha. Ayesha is an attractive and thin 27 year old Pakistani woman wearing large designer style sunglasses that cover her eyes. She does not resemble any public figure or celebrity. The brand persona photos may be used as a guide in creating a visual representation of Ayesha that you will use for your reference image and the subsequent video"
    }
  });

  // Query for completed videos with polling every 5 seconds
  const { data: completedVideos = [], isLoading } = useQuery({
    queryKey: ['/api/generations'],
    queryFn: () => api.getGenerations(),
    refetchInterval: 5000,
    refetchIntervalInBackground: true
  });


  const createGenerationMutation = (addGeneration: (taskId: string) => void) => useMutation({
    mutationFn: api.createGeneration,
    onSuccess: (data: { id: string; taskId: string }) => {
      toast({
        title: "Success!",
        description: "Video generation started successfully!"
      });
      
      // Add to status manager
      addGeneration(data.taskId);
      
      form.reset();
      setUploadedImage(null);
      queryClient.invalidateQueries({ queryKey: ['/api/generations'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const onSubmit = (data: FormData, mutation: ReturnType<typeof createGenerationMutation>) => {
    // Initialize audio context on first user interaction
    initialize();
    
    mutation.mutate({
      promptText: data.promptText,
      imagePath: uploadedImage?.path,
      brand_persona: data.brand_persona
    });
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Only PNG, JPG, WEBP, and GIF files are allowed",
        variant: "destructive"
      });
      return;
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "File size must be under 10MB",
        variant: "destructive"
      });
      return;
    }

    setIsUploading(true);
    try {
      const uploadResponse = await api.uploadFile(file);
      setUploadedImage({
        path: uploadResponse.objectPath,
        url: uploadResponse.mediaUrl
      });
      toast({
        title: "Upload successful",
        description: "Image uploaded successfully!"
      });
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive"
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const openMedia = (url: string) => {
    window.open(url, '_blank');
  };


  // Helper function to construct proper media URLs
  const getMediaUrl = (path: string): string => {
    // If path is already a full URL (starts with http/https), use it directly
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    
    // Handle /public-objects/ paths - serve directly via public endpoint
    if (path.startsWith('/public-objects/')) {
      return path;
    }
    
    // Handle /objects/ paths - serve via /api/media/ endpoint
    if (path.startsWith('/objects/')) {
      return `/api/media/${encodeURIComponent(path.replace('/objects/', ''))}`;
    }
    
    // Fallback for other relative paths
    return `/api/media/${encodeURIComponent(path)}`;
  };

  return (
    <GenerationStatusManager>
      {({ generations, addGeneration, dismissGeneration, toggleMinimize, retryGeneration }) => {
        const mutation = createGenerationMutation(addGeneration);
        
        return (
          <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-primary to-primary/80 rounded-lg flex items-center justify-center">
                <Video className="text-white" size={20} />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Fabbitt Product to Video Machine</h1>
                <p className="text-slate-600 mt-1">Transform your text and images into stunning videos</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <NotificationSettings />
              <AuthButton />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          
          {/* Left Panel - Create Video Form */}
          <div className="lg:col-span-2">
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <span>Create Video</span>
                  <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                
                {/* Tips Card */}
                <Alert className="bg-amber-50 border-amber-200">
                  <Lightbulb className="h-4 w-4 text-amber-600" />
                  <AlertDescription>
                    <div className="mt-1">
                      <h3 className="font-medium text-amber-900 mb-2">💡 Prompting Tips</h3>
                      <ol className="text-sm text-amber-800 space-y-1 list-decimal list-inside">
                        <li><strong>Product:</strong> what are you advertising? (e.g., "Celsius energy drink")</li>
                        <li><strong>Message:</strong> what should the video communicate? (e.g., "energizing fruit explosion")</li>
                        <li><strong>Style:</strong> format & tone (e.g., "Gen Z voice, high energy")</li>
                        <li><strong>Dimensions:</strong> Vertical (9:16) for mobile or horizontal (16:9) for desktop</li>
                      </ol>
                    </div>
                  </AlertDescription>
                </Alert>

                {/* Example Card */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                  <p className="text-sm text-slate-600">
                    <span className="font-medium text-slate-700">Example:</span> Create a Celsius energy drink advertisement with a fruit explosion theme, featuring a Gen Z voice with high energy saying 'Celsius - breathe energy into your life!' in vertical dimensions (9:16)
                  </p>
                </div>

                {/* Form */}
                <form onSubmit={form.handleSubmit((data) => onSubmit(data, mutation))} className="space-y-6">
                  {/* Product Description */}
                  <div>
                    <Label htmlFor="promptText" className="text-sm font-medium text-slate-700">
                      Product Description
                    </Label>
                    <Textarea
                      id="promptText"
                      placeholder="Describe your product and the video you want to create..."
                      className="mt-2 resize-none"
                      rows={4}
                      {...form.register("promptText")}
                    />
                    {form.formState.errors.promptText && (
                      <p className="text-sm text-red-600 mt-1">
                        {form.formState.errors.promptText.message}
                      </p>
                    )}
                  </div>

                  {/* Brand Persona */}
                  <div>
                    <Label htmlFor="brand_persona" className="text-sm font-medium text-slate-700">
                      Brand Persona
                    </Label>
                    <Textarea
                      id="brand_persona"
                      placeholder="Brand persona description..."
                      className="mt-2 resize-none"
                      rows={3}
                      {...form.register("brand_persona")}
                    />
                    {form.formState.errors.brand_persona && (
                      <p className="text-sm text-red-600 mt-1">
                        {form.formState.errors.brand_persona.message}
                      </p>
                    )}
                  </div>

                  {/* Upload Zone */}
                  <div>
                    <Label className="text-sm font-medium text-slate-700">
                      Image Upload (Optional)
                    </Label>
                    <div className="mt-2">
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                        className="hidden"
                      />
                      <div 
                        className="w-full border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-primary/40 transition-colors bg-slate-50 hover:bg-slate-100 cursor-pointer"
                        onClick={handleUploadClick}
                      >
                        {uploadedImage ? (
                          <div className="flex flex-col items-center space-y-3">
                            <div className="relative">
                              <img 
                                src={uploadedImage.url}
                                alt="Uploaded image preview"
                                className="max-w-full max-h-32 object-contain rounded-lg border border-slate-200"
                              />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-slate-700">
                                Click to upload a different image
                              </p>
                              <p className="text-xs text-slate-500 mt-1">PNG, JPG, GIF up to 10MB</p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center space-y-3">
                            <div className="w-12 h-12 bg-slate-200 rounded-lg flex items-center justify-center">
                              {isUploading ? (
                                <div className="w-6 h-6 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <Upload className="text-slate-500" size={24} />
                              )}
                            </div>
                            <div>
                              <p className="text-sm font-medium text-slate-700">
                                {isUploading ? "Uploading..." : "Click to upload or drag and drop"}
                              </p>
                              <p className="text-xs text-slate-500 mt-1">PNG, JPG, GIF up to 10MB</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    {uploadedImage && (
                      <div className="mt-2 text-sm text-green-600">
                        ✓ Image uploaded successfully
                      </div>
                    )}
                  </div>

                  {/* Submit Button */}
                  <Button 
                    type="submit" 
                    className="w-full bg-primary hover:bg-primary/90"
                    disabled={mutation.isPending}
                  >
                    {mutation.isPending ? (
                      <div className="flex items-center space-x-2">
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Generating...</span>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-2">
                        <Video className="w-4 h-4" />
                        <span>Generate Video</span>
                      </div>
                    )}
                  </Button>
                </form>

              </CardContent>
            </Card>
          </div>

          {/* Right Panel - Video Results */}
          <div className="lg:col-span-3" data-results-section>
            <Card className="shadow-sm min-h-[600px]">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <span>Video Results</span>
                  <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                  <span className="text-xs text-slate-500 ml-2">Updates every 5s</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                
                {/* Loading State */}
                {isLoading && (
                  <div className="space-y-4 animate-pulse">
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="border border-slate-200 rounded-lg p-4">
                        <div className="flex space-x-4">
                          <div className="flex space-x-3">
                            <div className="w-16 h-16 bg-slate-200 rounded-lg"></div>
                            <div className="w-16 h-16 bg-slate-200 rounded-lg"></div>
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="h-4 bg-slate-200 rounded w-3/4"></div>
                            <div className="h-4 bg-slate-200 rounded w-1/2"></div>
                            <div className="h-8 bg-slate-200 rounded w-24"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Empty State */}
                {!isLoading && completedVideos.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                      <Video className="text-slate-400" size={32} />
                    </div>
                    <h3 className="text-lg font-medium text-slate-900 mb-2">No videos yet</h3>
                    <p className="text-slate-600">Submit your text and image to see generated videos</p>
                  </div>
                )}

                {/* Video Results List */}
                {!isLoading && completedVideos.length > 0 && (
                  <div className="space-y-6">
                    {completedVideos
                      .filter((video: VideoGeneration) => 
                        // Additional safety check: only show videos with no error message and valid video path
                        !video.errorMessage && video.videoPath
                      )
                      .map((video: VideoGeneration) => (
                      <div key={video.id} className="border border-slate-200 rounded-lg p-6 hover:shadow-md transition-shadow bg-white">
                        
                        {/* Generated Image Section - Hero Display */}
                        {video.imageGenerationPath && (
                          <div className="mb-6">
                            <div 
                              className="relative group cursor-pointer w-full"
                              onClick={() => openMedia(getMediaUrl(video.imageGenerationPath!))}
                            >
                              <img 
                                src={getMediaUrl(video.imageGenerationPath)}
                                alt="Generated image"
                                className="w-full max-h-80 object-contain rounded-lg border border-slate-200 group-hover:ring-2 group-hover:ring-emerald-500 transition-all"
                              />
                              <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 rounded-lg transition-all"></div>
                              <div className="absolute top-2 right-2 w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <ExternalLink className="text-white" size={12} />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Video Section - Embedded Player */}
                        {video.videoPath && (
                          <div className="mb-6">
                            <div className="w-full">
                              <video 
                                className="w-full max-w-4xl mx-auto rounded-lg border border-slate-200 shadow-sm"
                                controls
                                preload="metadata"
                                style={{ maxHeight: '500px' }}
                                onError={(e) => {
                                  console.error('Video failed to load:', e);
                                  // Show fallback button if video fails
                                  const target = e.target as HTMLVideoElement;
                                  target.style.display = 'none';
                                  const fallback = target.nextElementSibling as HTMLElement;
                                  if (fallback) fallback.style.display = 'block';
                                }}
                              >
                                <source src={getMediaUrl(video.videoPath)} type="video/mp4" />
                                <source src={getMediaUrl(video.videoPath)} type="video/webm" />
                                <source src={getMediaUrl(video.videoPath)} type="video/quicktime" />
                                Your browser does not support the video tag.
                              </video>
                              
                              {/* Fallback button - hidden by default, shown if video fails */}
                              <div className="hidden flex items-center justify-center">
                                <Button
                                  size="lg"
                                  className="bg-slate-900 hover:bg-slate-800 text-white px-8 py-3"
                                  onClick={() => openMedia(getMediaUrl(video.videoPath!))}
                                >
                                  <Play className="mr-3" size={20} />
                                  Open Video in New Tab
                                </Button>
                              </div>
                              
                              {/* Secondary option to open in new tab */}
                              <div className="flex justify-center mt-2">
                                <button
                                  className="text-xs text-slate-500 hover:text-slate-700 underline flex items-center space-x-1"
                                  onClick={() => openMedia(getMediaUrl(video.videoPath!))}
                                >
                                  <ExternalLink size={10} />
                                  <span>Open in new tab</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Prompt Section with Header */}
                        <div className="mb-4">
                          <h4 className="text-sm font-semibold text-slate-900 mb-2">Prompt used to generate content</h4>
                          <p className="text-sm text-slate-700 leading-relaxed">
                            {video.promptText}
                          </p>
                        </div>
                        
                        {/* Metadata & Original Image Reference */}
                        <div className="flex items-center justify-between border-t border-slate-100 pt-4">
                          <div className="flex items-center space-x-4 text-xs text-slate-500">
                            <span>{new Date(video.createdAt!).toLocaleString()}</span>
                            <span className="inline-flex items-center px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1"></div>
                              Completed
                            </span>
                          </div>
                          
                          {/* Original Image Reference (if exists) */}
                          {video.imageOriginalPath && (
                            <div className="flex items-center space-x-2 text-xs text-slate-500">
                              <span>Original:</span>
                              <div 
                                className="relative group cursor-pointer"
                                onClick={() => openMedia(getMediaUrl(video.imageOriginalPath!))}
                              >
                                <img 
                                  src={getMediaUrl(video.imageOriginalPath)}
                                  alt="Original product image"
                                  className="w-8 h-8 object-cover rounded border border-slate-200 group-hover:ring-1 group-hover:ring-primary transition-all"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

              </CardContent>
            </Card>
          </div>

        </div>
      </div>

      {/* Floating Status Panel */}
      <FloatingStatusPanel
        generations={generations}
        onDismiss={dismissGeneration}
        onToggleMinimize={toggleMinimize}
        onRetry={retryGeneration}
      />
    </div>
        );
      }}
    </GenerationStatusManager>
  );
}
