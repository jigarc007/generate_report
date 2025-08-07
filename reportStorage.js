const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

console.log('NEXT_PUBLIC_SUPABASE_URL',process.env.SUPABASE_URL);
console.log('SUPABASE_URL',process.env.SUPABASE_URL);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

class ReportStorage {
  static async createJob(jobData) {
    const jobId = `report_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    const { error } = await supabase
      .from('report_jobs')
      .insert({
        id: jobId,
        brand_id: jobData.brandId,
        campaign_ids: jobData.campaignIds,
        from_date: jobData.fromDate,
        to_date: jobData.toDate,
        location_ids: jobData.locationIds,
        home_page_details: jobData.homePageDetails,
        logo: jobData.logo,
        currency: jobData.currency,
        time_zone: jobData.timeZone,
        status: 'pending',
        progress: 0,
        level: jobData.level,
      });

    if (error) {
      throw new Error(`Failed to create job: ${error.message}`);
    }

    return jobId;
  }

  static async getJob(jobId) {
    const { data, error } = await supabase
      .from('report_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      return null;
    }

    return {
      id: data.id,
      brandId: data.brand_id,
      campaignIds: data.campaign_ids,
      fromDate: data.from_date,
      toDate: data.to_date,
      locationIds: data.location_ids,
      homePageDetails: data.home_page_details,
      logo: data.logo,
      currency: data.currency,
      timeZone: data.time_zone,
      status: data.status,
      progress: data.progress,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      downloadUrl: data.download_url,
      error: data.error,
      level: data.level,
    };
  }

  static async updateJob(jobId, updates) {
    const dbUpdates = {};
    console.log('Updating job: ', jobId, updates);

    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.progress !== undefined) dbUpdates.progress = updates.progress;
    if (updates.downloadUrl !== undefined) dbUpdates.download_url = updates.downloadUrl;
    if (updates.error !== undefined) dbUpdates.error = updates.error;
    console.log({updates})
    const { error } = await supabase
      .from('report_jobs')
      .update(dbUpdates)
      .eq('id', jobId);

    if (error) {
      console.log('Update job error: ', error);
      throw new Error(`Failed to update job: ${error.message}`);
    }
  }

  static async cleanupOldJobs(olderThanHours = 24) {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - olderThanHours);

    const { error } = await supabase
      .from('report_jobs')
      .delete()
      .lt('created_at', cutoffTime.toISOString());

    if (error) {
      console.error('Failed to cleanup old jobs:', error.message);
    }
  }
}

module.exports = { ReportStorage };
