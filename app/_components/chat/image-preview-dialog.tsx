"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { X } from "lucide-react";

export type PreviewImage = {
  src: string;
  alt: string;
};

export function ImagePreviewDialog({
  image,
  onClose,
}: {
  image: PreviewImage | null;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setNaturalSize(null);
  }, [image?.src]);

  useEffect(() => {
    if (!image) return;
    const updateViewportSize = () => setViewportSize({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    updateViewportSize();
    window.addEventListener("resize", updateViewportSize);
    return () => window.removeEventListener("resize", updateViewportSize);
  }, [image]);

  useEffect(() => {
    if (!image) return;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedElement?.focus();
    };
  }, [image]);

  if (!image) return null;

  const previewSize = naturalSize && viewportSize
    ? (() => {
        const scale = Math.min(
          (viewportSize.width - 32) / naturalSize.width,
          (viewportSize.height - 32) / naturalSize.height,
          1,
        );
        return {
          width: Math.max(1, Math.round(naturalSize.width * scale)),
          height: Math.max(1, Math.round(naturalSize.height * scale)),
        };
      })()
    : null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`预览图片 ${image.alt}`}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="relative max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-sm"
        style={previewSize
          ? { height: previewSize.height, width: previewSize.width }
          : {
              height: "calc(100dvh - 2rem)",
              width: "min(80rem, calc(100vw - 2rem))",
            }}
      >
        <Image
          src={image.src}
          alt={image.alt}
          fill
          priority
          unoptimized
          sizes="100vw"
          className="object-contain"
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              setNaturalSize({ width: naturalWidth, height: naturalHeight });
            }
          }}
        />
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-slate-950/80 text-slate-100 shadow-lg transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          title="关闭预览"
          aria-label="关闭图片预览"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="pointer-events-none absolute inset-x-4 bottom-3 truncate text-center text-xs text-slate-300 drop-shadow-md">
          {image.alt}
        </div>
      </div>
    </div>,
    document.body,
  );
}
