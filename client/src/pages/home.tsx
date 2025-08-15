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
import type { VideoGeneration } from "@shared/schema";

const formSchema = z.object({
  promptText: z.string().min(1, "Product description is required")
});

type FormData = z.infer<typeof formSchema>;

export default function Home() {
  const [uploadedImage, setUploadedImage] = useState<{ path: string; url: string } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      promptText: ""
    }
  });

  // Query for completed videos with polling every 5 seconds
  const { data: completedVideos = [], isLoading } = useQuery({
    queryKey: ['/api/generations'],
    queryFn: () => api.getGenerations(),
    refetchInterval: 5000,
    refetchIntervalInBackground: true
  });

  const createGenerationMutation = useMutation({
    mutationFn: api.createGeneration,
    onSuccess: () => {
      toast({
        title: "Success!",
        description: "Video generation started successfully!"
      });
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

  const onSubmit = (data: FormData) => {
    createGenerationMutation.mutate({
      promptText: data.promptText,
      imagePath: uploadedImage?.path
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

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gradient-to-br from-primary to-primary/80 rounded-lg flex items-center justify-center">
              <Video className="text-white" size={20} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Fabbitt Product to Video Machine</h1>
              <p className="text-slate-600 text-sm font-medium">( inspired by Kev )</p>
            </div>
          </div>
          <p className="text-slate-600 mt-2">Transform your text and images into stunning videos</p>
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
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                    disabled={createGenerationMutation.isPending}
                  >
                    {createGenerationMutation.isPending ? (
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
          <div className="lg:col-span-3">
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
                  <div className="space-y-4">
                    {completedVideos.map((video: VideoGeneration) => (
                      <div key={video.id} className="border border-slate-200 rounded-lg p-4 hover:shadow-md transition-shadow">
                        <div className="flex flex-col lg:flex-row lg:items-start space-y-4 lg:space-y-0 lg:space-x-4">
                          
                          {/* Thumbnails Section */}
                          <div className="flex space-x-3 flex-shrink-0">
                            {/* Original Image Thumbnail */}
                            {video.imageOriginalPath && (
                              <div 
                                className="relative group cursor-pointer"
                                onClick={() => openMedia(`/api/media/${encodeURIComponent(video.imageOriginalPath!.replace('/objects/', ''))}`)}
                              >
                                <img 
                                  src={`/api/media/${encodeURIComponent(video.imageOriginalPath.replace('/objects/', ''))}`}
                                  alt="Original product image"
                                  className="w-16 h-16 object-cover rounded-lg border border-slate-200 group-hover:ring-2 group-hover:ring-primary transition-all"
                                />
                                <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 rounded-lg transition-all"></div>
                                <div className="absolute top-1 right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <ExternalLink className="text-white" size={8} />
                                </div>
                              </div>
                            )}

                            {/* Generated First Frame */}
                            {video.imageGenerationPath && (
                              <div 
                                className="relative group cursor-pointer"
                                onClick={() => openMedia(`/api/media/${encodeURIComponent(video.imageGenerationPath!.replace('/objects/', ''))}`)}
                              >
                                <img 
                                  src={`/api/media/${encodeURIComponent(video.imageGenerationPath.replace('/objects/', ''))}`}
                                  alt="Generated first frame"
                                  className="w-16 h-16 object-cover rounded-lg border border-slate-200 group-hover:ring-2 group-hover:ring-emerald-500 transition-all"
                                />
                                <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 rounded-lg transition-all"></div>
                                <div className="absolute top-1 right-1 w-4 h-4 bg-emerald-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                  <ExternalLink className="text-white" size={8} />
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Content Section */}
                          <div className="flex-grow min-w-0">
                            {/* Prompt Text */}
                            <p className="text-sm text-slate-700 mb-3 line-clamp-3">
                              {video.promptText}
                            </p>
                            
                            {/* Metadata */}
                            <div className="flex items-center space-x-4 text-xs text-slate-500 mb-3">
                              <span>{new Date(video.createdAt!).toLocaleString()}</span>
                              <span className="inline-flex items-center px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full mr-1"></div>
                                Completed
                              </span>
                            </div>

                            {/* Video Player Section */}
                            {video.videoPath && (
                              <div className="flex items-center space-x-3">
                                <Button
                                  size="sm"
                                  className="bg-slate-900 hover:bg-slate-800 text-white"
                                  onClick={() => openMedia(`/api/media/${encodeURIComponent(video.videoPath!.replace('/objects/', ''))}`)}
                                >
                                  <Play className="mr-2" size={14} />
                                  Play Video
                                </Button>
                              </div>
                            )}
                          </div>
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
    </div>
  );
}
