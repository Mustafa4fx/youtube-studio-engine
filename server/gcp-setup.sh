#!/usr/bin/env bash
# One-time Google Cloud setup for fast export on Cloud Run. Run it in Cloud Shell:
#   curl -sL https://raw.githubusercontent.com/Mustafa4fx/youtube-studio-engine/main/server/gcp-setup.sh | bash
# It enables the services, creates the render service account + image registry + bucket, then leaves the
# service-account key in the bucket ENCRYPTED with the server's RSA public key (only the server's private key opens it).
# The server picks it up by itself, deletes the public copy, and starts exporting on Cloud Run.
set -uo pipefail
main() {
NUM=658203090079; REGION=us-central1; B=studio-$NUM; SA_NAME=render-engine
ok() { echo "✅ $*"; }; step() { echo "⏳ $*"; }; die() { echo "❌ $*"; exit 1; }

P=$(gcloud projects list --filter="projectNumber=$NUM" --format='value(projectId)' 2>/dev/null)
[ -n "$P" ] || die "مش لاقي مشروع YouTube Studio Automation على الحساب ده — افتح Cloud Shell بنفس إيميل المشروع"
gcloud config set project "$P" -q >/dev/null 2>&1; ok "المشروع: $P"

step "1/6 تفعيل الخدمات (دقيقة تقريباً)"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com iam.googleapis.com apikeys.googleapis.com -q || die "تفعيل الخدمات فشل"
ok "الخدمات اتفعّلت"

step "2/6 حساب الخدمة"
SA="$SA_NAME@$P.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create $SA_NAME --display-name="Studio render engine" -q || die "إنشاء حساب الخدمة فشل"
sleep 8
for R in roles/run.admin roles/storage.admin roles/artifactregistry.admin; do
  gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$SA" --role=$R --condition=None -q >/dev/null || die "صلاحية $R فشلت"
done
gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser -q >/dev/null || die "صلاحية serviceAccountUser فشلت"
ok "الصلاحيات"

step "3/6 مخزن صور المحرك"
gcloud artifacts repositories describe studio --location=$REGION >/dev/null 2>&1 || gcloud artifacts repositories create studio --repository-format=docker --location=$REGION -q || die "Artifact Registry فشل"
ok "Artifact Registry"

step "4/6 مساحة التخزين المؤقتة"
gcloud storage buckets describe gs://$B >/dev/null 2>&1 || gcloud storage buckets create gs://$B --location=$REGION --no-uniform-bucket-level-access -q || die "إنشاء الـbucket فشل"
gcloud storage buckets update gs://$B --no-public-access-prevention -q >/dev/null 2>&1 || true
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":2,"matchesPrefix":["runs/","setup/"]}}]}' > /tmp/lc.json
gcloud storage buckets update gs://$B --lifecycle-file=/tmp/lc.json -q >/dev/null 2>&1 || true
ok "Cloud Storage (الملفات المؤقتة بتتمسح لوحدها بعد يومين)"

step "5/6 مفتاح المحرك (متشفّر بمفتاح السيرفر العام — محدش يقدر يفتحه غير السيرفر)"
T=$(mktemp -d)
curl -sf https://panel.helpanegyptian.com/videos/gcp-setup.pub.pem -o $T/pub.pem || { rm -rf $T; die "السيرفر لسه بيخلّص تصدير — جرّب نفس السطر كمان شوية (لما يظهر على صفحة الفيديوهات «☁️ Cloud: مستني الإعداد»)"; }
gcloud iam service-accounts keys create $T/sa.json --iam-account=$SA -q >/dev/null 2>&1 || { rm -rf $T; die "إنشاء المفتاح فشل"; }
openssl rand -hex 32 > $T/k
openssl enc -aes-256-cbc -pbkdf2 -pass file:$T/k -in $T/sa.json -out $T/sa.enc
openssl pkeyutl -encrypt -pubin -inkey $T/pub.pem -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -in $T/k -out $T/k.enc || { rm -rf $T; die "التشفير فشل"; }
shred -u $T/sa.json $T/k 2>/dev/null || rm -f $T/sa.json $T/k
tar -czf $T/keys.tgz -C $T sa.enc k.enc
gcloud storage cp $T/keys.tgz gs://$B/setup/keys.tgz -q >/dev/null 2>&1 || { rm -rf $T; die "رفع الملف المتشفّر فشل"; }
gcloud storage objects update gs://$B/setup/keys.tgz --add-acl-grant=entity=allUsers,role=READER -q >/dev/null 2>&1 || { rm -rf $T; die "مشاركة الملف المتشفّر فشلت"; }
rm -rf $T
ok "اتسلّم متشفّر — السيرفر هيفكّه بمفتاحه الخاص ويمسح النسخة من الـbucket لوحده"

step "6/6 خلاص"
echo ""
echo "🎉 الإعداد خلص. اقفل الصفحة دي — السيرفر هيكمّل لوحده، وهتلاقي «☁️ Cloud: شغال» على صفحة الفيديوهات."
}
main </dev/null
