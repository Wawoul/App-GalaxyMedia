# Keep kotlinx.serialization generated serializers.
# Signature is required for generic types (List<ManifestItem> etc.) - without it
# decoding fails only in minified release builds, i.e. exactly what ships.
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations, AnnotationDefault
-keep,includedescriptorclasses class com.galaxymedia.player.**$$serializer { *; }
-keepclassmembers class com.galaxymedia.player.** {
    *** Companion;
}
-keepclasseswithmembers class com.galaxymedia.player.** {
    kotlinx.serialization.KSerializer serializer(...);
}
