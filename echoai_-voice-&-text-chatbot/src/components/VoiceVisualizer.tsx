import { motion } from "motion/react";
import { cn } from "@/src/lib/utils";

interface VoiceVisualizerProps {
  isActive: boolean;
  volume: number;
  className?: string;
}

export function VoiceVisualizer({ isActive, volume, className }: VoiceVisualizerProps) {
  return (
    <div className={cn("flex items-center justify-center gap-1 h-12", className)}>
      {[...Array(8)].map((_, i) => (
        <motion.div
          key={i}
          animate={{
            height: isActive ? [12, Math.max(12, volume * 40 * (0.5 + Math.random())), 12] : 4,
            opacity: isActive ? 1 : 0.3,
          }}
          transition={{
            duration: 0.2,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.05,
          }}
          className="w-1.5 bg-blue-500 rounded-full"
        />
      ))}
    </div>
  );
}
