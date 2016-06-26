require('dotenv').config();
var fs = require('fs');
var async = require('async');
var sf = require('jsforce');
var Converter = require('csvtojson').Converter;
var converter = new Converter({});
var child_process = require('child_process');

//var config = { loginUrl:process.env.SF_URL, logLevel: "DEBUG" };
var added = { Account: 0, Contact: 0, Opportunity: 0 };
var config = { loginUrl:process.env.SF_URL };
var conn = new sf.Connection(config);

var yesterday = (function(d){d.setDate(d.getDate()-1); return d})(new Date);
var date = ("0" + yesterday.getDate()).slice(-2) + '/' + ("0" + (yesterday.getMonth()+1)).slice(-2) + '/' + yesterday.getFullYear(); // 25/06/2016
// Hackathon WARNING: Trusting the env vars to not be malicious
var wget1 = "wget --keep-session-cookies --save-cookies cookies.txt --post-data '__VIEWSTATE=" + process.env.CH_VIEWSTATE1 + "&ctl00$bodyContentContainer$SignInControl$EmailAddress=" + process.env.CH_USERNAME + "&ctl00$bodyContentContainer$SignInControl$Password=" + process.env.CH_PASSWORD + "&ctl00$bodyContentContainer$SignInControl$btnSignIn=Sign In' https://beta.canadahelps.com/en/SignIn.aspx -O /dev/null";
var wget2 = "wget --keep-session-cookies --load-cookies cookies.txt --post-data '__VIEWSTATE=" + process.env.CH_VIEWSTATE2 + "&ctl00$bodyContentContainer$txtFromDate=" + date + "&ctl00$bodyContentContainer$txtToDate=" + date + "&ctl00$bodyContentContainer$btnDownloadData.x=20&ctl00$bodyContentContainer$btnDownloadData.y=13' https://beta.canadahelps.com/en/Admin/MCDonations_DataDownload.aspx -O CharityDataDownload.csv";

child_process.exec(wget1, function (err, stdout, stderr) {
  if (err) { return console.err(err); }
  child_process.exec(wget2, function (err, stdout, stderr) {
    if (err) { return console.err(err); }
    converter.fromFile("./CharityDataDownload.csv", function(err,results) {
      if (err) { return console.error(err); }
      conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD + process.env.SF_ACCESS_TOKEN, function(err, user) {
        if (err) { return console.error(err); }
        var asyncTasks = [];
        results.forEach(function(result) {
          var account = { Name:'General' };
          if ((result['DONOR COMPANY NAME'] != '') && (result['DONOR COMPANY NAME'] != 'ANON')) {
            account.Name = result['DONOR COMPANY NAME'];
          }

          var contact = {};
          contact.FirstName = capitalizeFirstLetter(result['DONOR FIRST NAME']);
          if (contact.FirstName === '') { contact.FirstName = 'ANON'; }
          contact.LastName = capitalizeFirstLetter(result['DONOR LAST NAME']);
          if (contact.LastName === '') { contact.LastName = 'ANON'; }
          contact.Email = result['DONOR EMAIL ADDRESS'];
          if (contact.Email === '') { contact.Email = 'ANON'; }
          if (contact.Email.indexOf("@") === -1) { contact.Email += '@ANON.COM'; }
          contact.Email = contact.Email.toLowerCase();
          contact.MailingStreet = result['DONOR ADDRESS 1'] + '\n' + result['DONOR ADDRESS 2'];
          contact.MailingCity = result['DONOR CITY'];
          contact.MailingState = result['DONOR PROVINCE/STATE'];
          contact.MailingPostalCode = result['DONOR POSTAL/ZIP CODE'];
          contact.MailingCountry = result['DONOR COUNTRY'];

          var opportunity = {};
          opportunity.Name = result['TRANSACTION NUMBER'];
          opportunity.StageName = 'Closed 1';
          opportunity.Type = result['PAYMENT METHOD'];
          opportunity.Amount = result['AMOUNT'];
          opportunity.CloseDate = result['DONATION DATE'];
          opportunity.canh__Fee__c = result['FEE'];
          opportunity.canh__In_Honour__c = result['IN HONOUR OF'];
          opportunity.canh__In_Memory__c = result['IN MEMORY OF'];
          opportunity.canh__Honouree__c = result['HONOUREE'];
          opportunity.Description = result['MESSAGE TO CHARITY'];
          opportunity.canh__Donation_Source__c = result['DONATION SOURCE'];

          //console.log("-----------------------");
          //console.log(account);
          //console.log(contact);
          //console.log(opportunity);

          asyncTasks.push(function(callback) { createData("Account", "Name", account, callback); });
          asyncTasks.push(function(callback) { createData("Contact", "Email", contact, callback); });
          asyncTasks.push(function(callback) { createData("Opportunity", "Name", opportunity, callback); });
        });
        async.series(asyncTasks, function(){
          console.log("New Accounts:      " + added.Account + "\n" +
                      "New Contacts:      " + added.Contact + "\n" +
                      "New Opportunities: " + added.Opportunity);
        });
      });
    });
  });
});

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function createData(table, unique, data, callback) {
  console.log(data[unique]);
  conn.query("SELECT " + unique + " FROM " + table + " WHERE " + unique + " = '" + data[unique] + "'", function(err, result) {
    if (err) { callback(); return console.error(err); }
    if (result.totalSize > 0) { callback(); return; }
    conn.sobject(table).create(data, function(err, ret) {
      if (err || !ret.success) { callback(); return console.error(err, ret); }
      added[table]++;
      console.log("Created " + table + " record id : " + ret.id);
      callback();
    });
  });
}