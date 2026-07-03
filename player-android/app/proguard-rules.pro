# Keep kotlinx.serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.galaxymedia.player.**$$serializer { *; }
-keepclassmembers class com.galaxymedia.player.** {
    *** Companion;
}
-keepclasseswithmembers class com.galaxymedia.player.** {
    kotlinx.serialization.KSerializer serializer(...);
}
